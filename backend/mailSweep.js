// On startup, send order and account notices that were queued and never
// recorded. order_notify_log and account_audit_log are the source of truth:
// a sent row is not sent again. A sent timestamp is the same proof when the
// log write did not land. Anything else still queued is sent, and each
// resend is logged.

const { get, all, run } = require('./dbAsync');
const mailOutbox = require('./mailOutbox');

function label(row) {
  const who = row.scope === 'account' ? `user ${row.user_id}` : `order ${row.order_id}`;
  return `${row.scope} ${row.notice_type} ${row.channel} ${who}`;
}

function onceEver(row) {
  return row.notice_type === 'confirmation'
    || row.notice_type === 'welcome'
    || row.notice_type === 'password_set'
    || row.notice_type === 'pickup_request';
}

async function recorded(row) {
  const queued = await get(`SELECT created_at FROM mail_outbox WHERE id = ?`, [row.id]);
  const since = queued && queued.created_at ? queued.created_at : '1970-01-01 00:00:00';
  if (row.scope === 'account') {
    if (row.user_id == null) return null;
    if (onceEver(row)) {
      const sent = await get(
        `SELECT result FROM account_audit_log
         WHERE user_id = ? AND channel = ? AND notice_type = ? AND result = 'sent'
         ORDER BY id DESC
         LIMIT 1`,
        [row.user_id, row.channel, row.notice_type]
      );
      if (sent) return sent;
    }
    return get(
      `SELECT result FROM account_audit_log
       WHERE user_id = ? AND channel = ? AND notice_type = ?
         AND created_at >= ?
       ORDER BY id DESC
       LIMIT 1`,
      [row.user_id, row.channel, row.notice_type, since]
    );
  }
  if (onceEver(row)) {
    const sent = await get(
      `SELECT result FROM order_notify_log
       WHERE order_id = ? AND channel = ? AND notice_type = ? AND result = 'sent'
       ORDER BY id DESC
       LIMIT 1`,
      [row.order_id, row.channel, row.notice_type]
    );
    if (sent) return sent;
  }
  const logged = await get(
    `SELECT result FROM order_notify_log
     WHERE order_id = ? AND channel = ? AND notice_type = ?
       AND created_at >= ?
     ORDER BY id DESC
     LIMIT 1`,
    [row.order_id, row.channel, row.notice_type, since]
  );
  if (logged) return logged;
  if (row.notice_type === 'confirmation' && row.order_id != null) {
    const order = await get(
      `SELECT confirmation_email_sent_at FROM orders WHERE id = ?`,
      [row.order_id]
    );
    if (order && order.confirmation_email_sent_at) return { result: 'sent' };
  }
  if (row.notice_type === 'pickup_request' && row.order_id != null) {
    const pickup = await get(
      `SELECT confirmation_email_sent_at FROM pickup_requests
       WHERE order_id = ? AND confirmation_email_sent_at IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
      [row.order_id]
    );
    if (pickup) return { result: 'sent' };
  }
  return null;
}

async function repairSent(row) {
  if (row.notice_type !== 'confirmation' || row.order_id == null) return;
  await run(
    `UPDATE orders
     SET confirmation_email_status = 'sent',
         confirmation_email_sent_at = COALESCE(confirmation_email_sent_at, datetime('now'))
     WHERE id = ? AND confirmation_email_sent_at IS NULL`,
    [row.order_id]
  );
}

async function adoptPendingConfirmations() {
  const table = await get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orders'`);
  if (!table) return;
  const pending = await all(
    `SELECT id FROM orders
     WHERE confirmation_email_status = 'pending'
       AND confirmation_email_sent_at IS NULL`
  );
  for (const order of pending) {
    await mailOutbox.enqueue({
      scope: 'order',
      orderId: order.id,
      channel: 'email',
      noticeType: 'confirmation',
    });
  }
}

async function dispatch(row) {
  if (row.scope === 'account') {
    const accountMail = require('./accountMail');
    const user = await get(
      `SELECT id, username, email, display_name, contact_name FROM users WHERE id = ?`,
      [row.user_id]
    );
    if (!user) return { status: 'skipped' };
    if (row.notice_type === 'welcome') return accountMail.sendSignupWelcome(user);
    if (row.notice_type === 'password_set') return accountMail.sendStaffWelcome(user);
    if (row.notice_type === 'password_reset') return accountMail.sendPasswordResetNotice(user);
    return { status: 'skipped' };
  }
  if (row.notice_type === 'confirmation') {
    const orderConfirm = require('./orderConfirm');
    return orderConfirm.deliverQueued(row.order_id);
  }
  if (row.notice_type === 'pickup_request') {
    const pickupRequests = require('./pickupRequests');
    return pickupRequests.sendQueuedConfirmation(row.order_id);
  }
  return { status: 'skipped' };
}

async function sweepOnce() {
  try {
    await mailOutbox.ensureSchema();
  } catch (err) {
    console.error('MAIL SWEEP ERROR:', err && err.message ? err.message : 'failed');
    return { resent: 0, skipped: 0 };
  }
  await adoptPendingConfirmations();
  const rows = await all(
    `SELECT id, scope, order_id, user_id, channel, notice_type, status, claimed_by, claimed_at, created_at
     FROM mail_outbox
     WHERE status IN ('queued', 'sending')
     ORDER BY id`
  );
  let resent = 0;
  let skipped = 0;
  for (const row of rows) {
    const fields = {
      scope: row.scope,
      orderId: row.order_id,
      userId: row.user_id,
      channel: row.channel,
      noticeType: row.notice_type,
    };
    try {
      if (mailOutbox.isSending(fields)) {
        skipped += 1;
        console.log(`MAIL SWEEP: ${label(row)} already sending in this process`);
        continue;
      }
      const prior = await recorded(row);
      if (prior) {
        if (prior.result === 'sent') await repairSent(row);
        const gate = await mailOutbox.acquire(fields);
        if (gate === 'owned') await mailOutbox.complete(row.id);
        skipped += 1;
        console.log(`MAIL SWEEP: ${label(row)} already recorded (${prior.result})`);
        continue;
      }
      const outcome = await dispatch(row);
      if (outcome && outcome.leased) {
        skipped += 1;
        console.log(`MAIL SWEEP: ${label(row)} leased by another process`);
        continue;
      }
      const status = outcome && outcome.status ? outcome.status : 'failed';
      if (status === 'sent' || status === 'failed') {
        resent += 1;
        console.log(`MAIL RESEND: ${label(row)} result=${status}`);
      } else {
        console.log(`MAIL SWEEP: ${label(row)} result=${status}`);
      }
    } catch (err) {
      console.error('MAIL SWEEP ERROR:', err && err.message ? err.message : 'failed');
      try {
        await mailOutbox.releaseMatching(fields);
      } catch (releaseErr) {
        console.error('MAIL SWEEP ERROR:', releaseErr && releaseErr.message ? releaseErr.message : 'failed');
      }
    }
  }
  return { resent, skipped };
}

let tail = Promise.resolve();
let repeatTimer = null;
let stopped = false;

function sweepOnceSerialized() {
  const run = tail.then(() => sweepOnce(), () => sweepOnce());
  tail = run.then(() => {}, () => {});
  return run;
}

function repeatDelayMs() {
  return Math.max(1000, Math.min(mailOutbox.leaseMs(), 5000));
}

// Keeps looking for a lease the previous process abandoned. One follow-up
// is not enough: that process renews the lease until its drain ends, which
// can be later than a single timer. The interval is unref'd and stops when
// this process itself drains.
function startRepeating() {
  if (repeatTimer || stopped) return;
  repeatTimer = setInterval(() => {
    if (stopped) return;
    sweepOnceSerialized().catch((err) => {
      console.error('MAIL SWEEP ERROR:', err && err.message ? err.message : 'failed');
    });
  }, repeatDelayMs());
  if (typeof repeatTimer.unref === 'function') repeatTimer.unref();
}

function stop() {
  stopped = true;
  if (repeatTimer) clearInterval(repeatTimer);
  repeatTimer = null;
}

function sweep(options = {}) {
  const promise = sweepOnceSerialized();
  if (options.followUp) promise.finally(() => startRepeating());
  return promise;
}

module.exports = {
  sweep,
  stop,
  recorded,
};

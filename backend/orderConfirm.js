// One confirmation email per order. A later call sees the status column and
// does not send again. Mail trouble is recorded and not thrown.

const { get, run } = require('./dbAsync');
const mailer = require('./mailer');
const mailOutbox = require('./mailOutbox');
const systemSettings = require('./systemSettings');
const { loadLetterhead, letterheadFromMap } = require('./shopProfile');

function customerEmail(row) {
  const candidates = [row && row.email, row && row.account_email];
  for (const candidate of candidates) {
    const parsed = mailer.parseAddressList(candidate, { max: 1, field: 'email' });
    if (!parsed.error && parsed.value && parsed.value.length === 1) return parsed.value[0];
  }
  return null;
}

function stampNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function publicConfirmation(result) {
  const status = result && result.status ? result.status : 'failed';
  const payload = {
    email_sent: status === 'sent',
    email_status: status,
  };
  if (process.env.NODE_ENV === 'test' && result && result.preview) payload.preview = result.preview;
  return payload;
}

const pendingIds = new Set();
const outcomes = new Map();

function noteScheduled(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id)) return;
  pendingIds.add(id);
}

function noteFinished(orderId, result) {
  const id = Number(orderId);
  if (!Number.isInteger(id)) return;
  outcomes.set(id, result);
  pendingIds.delete(id);
}

function outcomeFor(orderId) {
  return outcomes.get(Number(orderId)) || null;
}

function isPending(orderId) {
  return pendingIds.has(Number(orderId));
}

async function deliver(orderId) {
  let result;
  try {
    result = await deliverOnce(orderId);
  } catch (err) {
    console.error('ORDER CONFIRM ERROR:', err && err.message ? err.message : 'failed');
    result = { status: 'failed', email_sent: false };
  }
  noteFinished(orderId, result);
  try {
    await mailOutbox.completeMatching({
      scope: 'order',
      orderId,
      channel: 'email',
      noticeType: 'confirmation',
    });
  } catch (err) {
    console.error('MAIL OUTBOX ERROR:', err && err.message ? err.message : 'failed');
  }
  return result;
}

// Startup sweep entry. A crash leaves confirmation_email_status pending and
// no sent row in the order notification log. Clearing that claim lets the
// normal send run once. A later call still sees the log and does not repeat.
async function deliverQueued(orderId) {
  await run(
    `UPDATE orders
     SET confirmation_email_status = NULL, updated_at = datetime('now')
     WHERE id = ?
       AND confirmation_email_sent_at IS NULL
       AND confirmation_email_status = 'pending'`,
    [orderId]
  );
  return deliver(orderId);
}

async function deliverOnce(orderId) {
  try {
    const enabled = await systemSettings.emailOrderConfirmation();
    if (!enabled) return { status: 'disabled', email_sent: false };

    const claimed = await run(
      `UPDATE orders
       SET confirmation_email_status = 'pending', updated_at = datetime('now')
       WHERE id = ?
         AND confirmation_email_sent_at IS NULL
         AND (confirmation_email_status IS NULL OR trim(confirmation_email_status) = '')`,
      [orderId]
    );
    if (!claimed.changes) {
      const existing = await get(
        `SELECT confirmation_email_status, confirmation_email_sent_at FROM orders WHERE id = ?`,
        [orderId]
      );
      const status = existing && existing.confirmation_email_status ? existing.confirmation_email_status : 'skipped';
      return {
        status,
        email_sent: Boolean(existing && existing.confirmation_email_sent_at),
        skipped: true,
      };
    }

    const row = await get(
      `SELECT o.id, o.order_number, o.email, o.due_date, o.due_time, o.delivery_method, o.ship_to,
              u.email AS account_email
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       WHERE o.id = ?`,
      [orderId]
    );
    if (!row) {
      await run(`UPDATE orders SET confirmation_email_status = 'skipped' WHERE id = ?`, [orderId]);
      return { status: 'skipped', email_sent: false };
    }

    const to = customerEmail(row);
    if (!to) {
      await run(`UPDATE orders SET confirmation_email_status = 'skipped' WHERE id = ?`, [orderId]);
      return { status: 'skipped', email_sent: false };
    }

    let letterhead;
    try {
      letterhead = await loadLetterhead();
    } catch (err) {
      letterhead = letterheadFromMap({});
    }
    const rendered = mailer.renderOrderConfirmationEmail({
      letterhead,
      orderNumber: row.order_number,
      dueDate: row.due_date,
      dueTime: row.due_time,
      deliveryMethod: row.delivery_method,
      shipTo: row.ship_to,
      link: mailer.orderPageLink(orderId),
    });
    const sent = await mailer.deliver({
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      noticeType: 'confirmation',
    });
    const status = sent && sent.status ? sent.status : 'failed';
    const customerNotices = require('./customerNotices');
    await customerNotices.recordOrderNotice({
      orderId,
      channel: 'email',
      noticeType: 'confirmation',
      recipient: to,
      result: status,
    });
    if (status === 'sent') {
      await run(
        `UPDATE orders
         SET confirmation_email_sent_at = ?, confirmation_email_status = 'sent'
         WHERE id = ?`,
        [stampNow(), orderId]
      );
    } else {
      await run(`UPDATE orders SET confirmation_email_status = ? WHERE id = ?`, [status, orderId]);
    }
    const result = { status, email_sent: status === 'sent', to };
    if (process.env.NODE_ENV === 'test' && sent && sent.captured) {
      result.preview = mailer.previewFrom(sent.captured);
    }
    return result;
  } catch (err) {
    console.error('ORDER CONFIRM ERROR:', err && err.message ? err.message : 'failed');
    try {
      await run(
        `UPDATE orders SET confirmation_email_status = 'failed'
         WHERE id = ? AND confirmation_email_sent_at IS NULL AND confirmation_email_status = 'pending'`,
        [orderId]
      );
    } catch (stampErr) {
      console.error('ORDER CONFIRM STAMP ERROR:', stampErr && stampErr.message ? stampErr.message : 'failed');
    }
    return { status: 'failed', email_sent: false };
  }
}

module.exports = {
  deliver,
  deliverQueued,
  publicConfirmation,
  noteScheduled,
  outcomeFor,
  isPending,
};

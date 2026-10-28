// Order notices stay on the order. Account notices (welcome, set-password,
// password reset) stay on the account audit log. Neither record includes the
// message body.

const { get, all, run } = require('./dbAsync');

async function recordOrderNotice({ orderId, channel, noticeType, recipient, result }) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    await run(
      `INSERT INTO order_notify_log (order_id, channel, notice_type, recipient, result, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [
        id,
        String(channel || 'email').slice(0, 20),
        String(noticeType || 'notice').slice(0, 80),
        recipient ? String(recipient).slice(0, 320) : null,
        result ? String(result).slice(0, 80) : 'failed',
      ]
    );
  } catch (err) {
    console.error('ORDER NOTICE LOG ERROR:', err && err.message ? err.message : 'failed');
  }
}

async function recordAccountNotice({ userId, channel, noticeType, recipient, result }) {
  try {
    await run(
      `INSERT INTO account_audit_log (user_id, channel, notice_type, recipient, result, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [
        userId == null ? null : Number(userId),
        String(channel || 'email').slice(0, 20),
        String(noticeType || 'notice').slice(0, 80),
        recipient ? String(recipient).slice(0, 320) : null,
        result ? String(result).slice(0, 80) : 'failed',
      ]
    );
  } catch (err) {
    console.error('ACCOUNT AUDIT LOG ERROR:', err && err.message ? err.message : 'failed');
  }
}

async function orderNotices(orderId) {
  return all(
    `SELECT id, channel, notice_type, recipient, result, created_at
     FROM order_notify_log
     WHERE order_id = ?
     ORDER BY id`,
    [orderId]
  );
}

async function listAccountAudit({ limit = 100, offset = 0 } = {}) {
  const rows = await all(
    `SELECT a.id, a.user_id, a.channel, a.notice_type, a.recipient, a.result, a.created_at,
            u.username, u.display_name
     FROM account_audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const total = await get('SELECT COUNT(*) AS count FROM account_audit_log');
  return {
    entries: rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      username: row.username || null,
      display_name: row.display_name || null,
      channel: row.channel,
      notice_type: row.notice_type,
      recipient: row.recipient,
      result: row.result,
      created_at: row.created_at,
    })),
    total: total ? total.count : 0,
    limit,
    offset,
  };
}

module.exports = {
  recordOrderNotice,
  recordAccountNotice,
  orderNotices,
  listAccountAudit,
};

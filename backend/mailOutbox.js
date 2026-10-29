// Durable queue for order and account mail. The process can exit after a
// notice is queued and before the notification log is written. The log stays
// the source of truth for whether the message was sent.

const { get, run } = require('./dbAsync');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mail_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  order_id INTEGER,
  user_id INTEGER,
  channel TEXT NOT NULL,
  notice_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
)`;

function dbOf(executor) {
  if (executor && typeof executor.run === 'function') return executor;
  return { get, run };
}

async function ensureSchema(executor) {
  const db = dbOf(executor);
  await db.run(SCHEMA);
  await db.run('CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status, id)');
}

async function enqueue(fields, executor) {
  const db = dbOf(executor);
  const scope = fields.scope === 'account' ? 'account' : 'order';
  const orderId = fields.orderId == null ? null : Number(fields.orderId);
  const userId = fields.userId == null ? null : Number(fields.userId);
  const channel = String(fields.channel || 'email').slice(0, 20);
  const noticeType = String(fields.noticeType || 'notice').slice(0, 80);
  const existing = await db.get(
    `SELECT id FROM mail_outbox
     WHERE scope = ? AND channel = ? AND notice_type = ?
       AND ifnull(order_id, -1) = ifnull(?, -1)
       AND ifnull(user_id, -1) = ifnull(?, -1)
       AND status IN ('queued', 'sending')
     ORDER BY id
     LIMIT 1`,
    [scope, channel, noticeType, orderId, userId]
  );
  if (existing) return existing.id;
  const inserted = await db.run(
    `INSERT INTO mail_outbox (scope, order_id, user_id, channel, notice_type, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', datetime('now'))`,
    [scope, orderId, userId, channel, noticeType]
  );
  return inserted.lastID;
}

async function complete(id, executor) {
  if (!id) return;
  const db = dbOf(executor);
  await db.run(
    `UPDATE mail_outbox SET status = 'done', updated_at = datetime('now')
     WHERE id = ? AND status != 'done'`,
    [id]
  );
}

async function completeMatching(fields, executor) {
  const db = dbOf(executor);
  const scope = fields.scope === 'account' ? 'account' : 'order';
  await db.run(
    `UPDATE mail_outbox SET status = 'done', updated_at = datetime('now')
     WHERE scope = ? AND channel = ? AND notice_type = ?
       AND ifnull(order_id, -1) = ifnull(?, -1)
       AND ifnull(user_id, -1) = ifnull(?, -1)
       AND status IN ('queued', 'sending')`,
    [
      scope,
      String(fields.channel || 'email'),
      String(fields.noticeType || 'notice'),
      fields.orderId == null ? null : Number(fields.orderId),
      fields.userId == null ? null : Number(fields.userId),
    ]
  );
}

module.exports = {
  SCHEMA,
  ensureSchema,
  enqueue,
  complete,
  completeMatching,
};

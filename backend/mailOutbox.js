// Durable queue for order and account mail. The process can exit after a
// notice is queued and before the notification log is written. The log stays
// the source of truth for whether the message was sent.
//
// A row is leased to the process that queued or started it. Another process
// will not send that row until the lease is older than the drain bound plus
// a margin, so a deploy that overlaps a draining process does not send twice.

const crypto = require('crypto');
const { get, all, run } = require('./dbAsync');

const claimant = crypto.randomBytes(16).toString('hex');
const LEASE_MARGIN_MS_DEFAULT = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mail_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  order_id INTEGER,
  user_id INTEGER,
  channel TEXT NOT NULL,
  notice_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  claimed_by TEXT,
  claimed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
)`;

const ACTIVE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_outbox_active
  ON mail_outbox(scope, channel, notice_type, ifnull(order_id, -1), ifnull(user_id, -1))
  WHERE status IN ('queued', 'sending')`;

function dbOf(executor) {
  if (executor && typeof executor.run === 'function' && typeof executor.get === 'function') return executor;
  return { get, all, run };
}

function drainBoundMs() {
  const parsed = Number(process.env.DRAIN_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120000) return 20000;
  return parsed;
}

function leaseMs() {
  const margin = Number(process.env.MAIL_SWEEP_LEASE_MARGIN_MS);
  const marginMs = Number.isInteger(margin) && margin >= 0 && margin <= 120000 ? margin : LEASE_MARGIN_MS_DEFAULT;
  return drainBoundMs() + marginMs;
}

function leaseSeconds() {
  return Math.max(1, Math.ceil(leaseMs() / 1000));
}

function keyOf(fields) {
  const scope = fields.scope === 'account' ? 'account' : 'order';
  return {
    scope,
    orderId: fields.orderId == null ? null : Number(fields.orderId),
    userId: fields.userId == null ? null : Number(fields.userId),
    channel: String(fields.channel || 'email').slice(0, 20),
    noticeType: String(fields.noticeType || 'notice').slice(0, 80),
  };
}

async function ensureActiveIndex(db) {
  const duplicate = await db.get(
    `SELECT scope, channel, notice_type,
            ifnull(order_id, -1) AS order_key,
            ifnull(user_id, -1) AS user_key,
            COUNT(*) AS n
     FROM mail_outbox
     WHERE status IN ('queued', 'sending')
     GROUP BY scope, channel, notice_type, ifnull(order_id, -1), ifnull(user_id, -1)
     HAVING COUNT(*) > 1
     LIMIT 1`
  );
  if (duplicate) {
    console.warn('Skipping unique mail_outbox index because duplicate queued rows exist');
    return;
  }
  await db.run(ACTIVE_INDEX);
}

async function ensureSchema(executor) {
  const db = dbOf(executor);
  await db.run(SCHEMA);
  const cols = await db.all('PRAGMA table_info(mail_outbox)');
  const names = new Set((cols || []).map((col) => col.name));
  if (!names.has('claimed_by')) await db.run('ALTER TABLE mail_outbox ADD COLUMN claimed_by TEXT');
  if (!names.has('claimed_at')) await db.run('ALTER TABLE mail_outbox ADD COLUMN claimed_at DATETIME');
  await db.run('CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status, id)');
  await ensureActiveIndex(db);
}

async function findActive(fields, executor) {
  const db = dbOf(executor);
  const key = keyOf(fields);
  return db.get(
    `SELECT id FROM mail_outbox
     WHERE scope = ? AND channel = ? AND notice_type = ?
       AND ifnull(order_id, -1) = ifnull(?, -1)
       AND ifnull(user_id, -1) = ifnull(?, -1)
       AND status IN ('queued', 'sending')
     ORDER BY id
     LIMIT 1`,
    [key.scope, key.channel, key.noticeType, key.orderId, key.userId]
  );
}

async function enqueue(fields, executor) {
  const db = dbOf(executor);
  const key = keyOf(fields);
  const insert = () => db.run(
    `INSERT OR IGNORE INTO mail_outbox
       (scope, order_id, user_id, channel, notice_type, status, claimed_by, claimed_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, datetime('now'), datetime('now'))`,
    [key.scope, key.orderId, key.userId, key.channel, key.noticeType, claimant]
  );
  const inserted = await insert();
  if (inserted.changes) return inserted.lastID;
  const existing = await findActive(fields, executor);
  if (existing) return existing.id;
  const again = await insert();
  if (again.changes) return again.lastID;
  const found = await findActive(fields, executor);
  return found ? found.id : null;
}

async function claim(id, executor) {
  const db = dbOf(executor);
  const updated = await db.run(
    `UPDATE mail_outbox
     SET status = 'sending',
         claimed_by = ?,
         claimed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?
       AND status IN ('queued', 'sending')
       AND (
         claimed_by = ?
         OR claimed_at IS NULL
         OR datetime(claimed_at) <= datetime('now', ?)
       )`,
    [claimant, id, claimant, `-${leaseSeconds()} seconds`]
  );
  return updated.changes === 1;
}

// 'owned' means this process may send. 'leased' means another process still
// holds the row. 'none' means there is no active outbox row.
async function acquire(fields, executor) {
  const row = await findActive(fields, executor);
  if (!row) return 'none';
  const ok = await claim(row.id, executor);
  return ok ? 'owned' : 'leased';
}

async function complete(id, executor) {
  if (!id) return;
  const db = dbOf(executor);
  await db.run(
    `UPDATE mail_outbox SET status = 'done', updated_at = datetime('now')
     WHERE id = ? AND status != 'done' AND (claimed_by IS NULL OR claimed_by = ?)`,
    [id, claimant]
  );
}

async function completeMatching(fields, executor) {
  const db = dbOf(executor);
  const key = keyOf(fields);
  await db.run(
    `UPDATE mail_outbox SET status = 'done', updated_at = datetime('now')
     WHERE scope = ? AND channel = ? AND notice_type = ?
       AND ifnull(order_id, -1) = ifnull(?, -1)
       AND ifnull(user_id, -1) = ifnull(?, -1)
       AND status IN ('queued', 'sending')
       AND (claimed_by IS NULL OR claimed_by = ?)`,
    [key.scope, key.channel, key.noticeType, key.orderId, key.userId, claimant]
  );
}

async function releaseMatching(fields, executor) {
  const db = dbOf(executor);
  const key = keyOf(fields);
  await db.run(
    `UPDATE mail_outbox
     SET status = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = datetime('now')
     WHERE scope = ? AND channel = ? AND notice_type = ?
       AND ifnull(order_id, -1) = ifnull(?, -1)
       AND ifnull(user_id, -1) = ifnull(?, -1)
       AND status = 'sending'
       AND claimed_by = ?`,
    [key.scope, key.channel, key.noticeType, key.orderId, key.userId, claimant]
  );
}

module.exports = {
  SCHEMA,
  ACTIVE_INDEX,
  claimant,
  leaseMs,
  leaseSeconds,
  ensureSchema,
  enqueue,
  claim,
  acquire,
  complete,
  completeMatching,
  releaseMatching,
};

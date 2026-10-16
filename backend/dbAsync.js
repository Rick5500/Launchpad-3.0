const sqlite3 = require('sqlite3').verbose();
const db = require('./db');
const { BUSY_TIMEOUT_MS, BUSY_ATTEMPTS, isBusyError, delay, backoffMs } = require('./sqliteBusy');

let transactionQueue = Promise.resolve();

function enqueueTransaction(task) {
  const runTask = transactionQueue.then(task, task);
  transactionQueue = runTask.then(() => {}, () => {});
  return runTask;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function runOn(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getOn(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function allOn(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function openTransactionConnection() {
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(db.filePath, (openErr) => {
      if (openErr) {
        reject(openErr);
        return;
      }
      conn.configure('busyTimeout', BUSY_TIMEOUT_MS);
      conn.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`, (pragmaErr) => {
        if (pragmaErr) {
          conn.close(() => reject(pragmaErr));
          return;
        }
        resolve(conn);
      });
    });
  });
}

async function withTransactionOnce(fn) {
  const conn = await openTransactionConnection();
  const tx = {
    run: (sql, params) => runOn(conn, sql, params),
    get: (sql, params) => getOn(conn, sql, params),
    all: (sql, params) => allOn(conn, sql, params),
  };
  const close = () => new Promise((resolve) => conn.close(() => resolve()));

  try {
    await tx.run('BEGIN IMMEDIATE');
  } catch (beginErr) {
    await close();
    throw beginErr;
  }

  try {
    const result = await fn(tx);
    await tx.run('COMMIT');
    await close();
    return result;
  } catch (err) {
    try { await tx.run('ROLLBACK'); } catch (rollbackErr) { /* already aborted */ }
    await close();
    throw err;
  }
}

// One process-wide queue and a fresh connection per transaction. Callbacks must
// use the tx argument; the shared connection is not inside this transaction.
function withTransaction(fn) {
  return enqueueTransaction(async () => {
    let lastErr;
    for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt += 1) {
      try {
        return await withTransactionOnce(fn);
      } catch (err) {
        lastErr = err;
        if (!isBusyError(err) || attempt + 1 >= BUSY_ATTEMPTS) throw err;
        await delay(backoffMs(attempt));
      }
    }
    throw lastErr;
  });
}

module.exports = {
  run,
  get,
  all,
  withTransaction,
};

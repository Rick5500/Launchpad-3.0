const db = require('./db');

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

async function withTransaction(work) {
  await run('BEGIN IMMEDIATE');
  try {
    const result = await work();
    await run('COMMIT');
    return result;
  } catch (err) {
    try {
      await run('ROLLBACK');
    } catch (rollbackErr) {
      console.error('ROLLBACK ERROR:', rollbackErr);
    }
    throw err;
  }
}

module.exports = {
  run,
  get,
  all,
  withTransaction,
};

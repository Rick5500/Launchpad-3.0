const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { BUSY_TIMEOUT_MS, BUSY_ATTEMPTS, isBusyError, backoffMs } = require('./sqliteBusy');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'database', 'launchpad.db');
const db = new sqlite3.Database(dbFile);
db.configure('busyTimeout', BUSY_TIMEOUT_MS);
db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
db.filePath = dbFile;

function wrapBusy(methodName) {
  const original = db[methodName];
  db[methodName] = function wrapped(...args) {
    const hasCallback = args.length > 0 && typeof args[args.length - 1] === 'function';
    const callback = hasCallback ? args[args.length - 1] : null;
    const params = hasCallback ? args.slice(0, -1) : args.slice();

    const invoke = (attempt) => original.call(db, ...params, function onResult(err) {
      if (isBusyError(err) && attempt + 1 < BUSY_ATTEMPTS) {
        setTimeout(() => invoke(attempt + 1), backoffMs(attempt));
        return;
      }
      if (callback) callback.apply(this, arguments);
    });

    return invoke(0);
  };
}

wrapBusy('run');
wrapBusy('get');
wrapBusy('all');
wrapBusy('exec');

module.exports = db;

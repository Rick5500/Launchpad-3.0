const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'database', 'launchpad.db');
const db = new sqlite3.Database(dbFile);

module.exports = db;

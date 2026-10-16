const db = require('./db');

// Same letterhead as the owner's printable work order mockup.
const DEFAULT_NAME = 'Accent Imaging, Inc.';
const DEFAULT_ADDRESS = '8121 Brownleigh Drive\nRaleigh, NC 27617';
const DEFAULT_PHONE = '919-782-3332';

function addressLines(address) {
  return String(address || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function letterheadFromMap(map) {
  const name = String((map && map.company_name) || '').trim() || DEFAULT_NAME;
  const address = String((map && map.company_address) || '').trim() || DEFAULT_ADDRESS;
  const phone = String((map && map.company_phone) || '').trim() || DEFAULT_PHONE;
  return {
    name,
    address,
    address_lines: addressLines(address),
    phone,
  };
}

function loadLetterhead() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT key, value FROM system_settings
       WHERE key IN ('company_name', 'company_address', 'company_phone')`,
      [],
      (err, rows) => {
        if (err) {
          if (/no such table/i.test(String(err.message || ''))) {
            return resolve(letterheadFromMap({}));
          }
          return reject(err);
        }
        const map = {};
        for (const row of rows || []) map[row.key] = row.value;
        resolve(letterheadFromMap(map));
      }
    );
  });
}

module.exports = {
  DEFAULT_NAME,
  DEFAULT_ADDRESS,
  DEFAULT_PHONE,
  addressLines,
  letterheadFromMap,
  loadLetterhead,
};

const activityLog = require('./activityLog');
const { withTransaction } = require('./dbAsync');
const { all } = require('./dbAsync');
const {
  STORAGE_DOWN_MESSAGE,
  uploadDir,
  legacyRoot,
  rootsEqual,
  safeStoredPath,
  ensureUploadDir,
  inspectStored,
  copyVerified,
  removeStored,
} = require('./fileStore');

const FILE_TABLES = Object.freeze([
  'order_files',
  'shared_files',
  'proof_files',
  'inbound_email_attachments',
]);

function recordSize(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

async function stamp(table, id, root, previous) {
  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE ${table} SET storage_root = ?, storage_previous = ? WHERE id = ?`,
      [root, previous, id]
    );
  });
}

async function moveRow(table, row, target) {
  const name = String(row.stored_name || '').trim();
  const size = recordSize(row.size_bytes);
  const recordedRoot = textOrNull(row.storage_root);
  const previousRoot = textOrNull(row.storage_previous);
  const sourceRoot = previousRoot || recordedRoot || legacyRoot();
  const targetPath = safeStoredPath(name, target);
  if (!targetPath) return { status: 'failed', error: 'Stored name is not allowed' };
  const sourcePath = safeStoredPath(name, sourceRoot);
  if (!sourcePath) return { status: 'failed', error: 'Stored name is not allowed' };

  const targetInfo = inspectStored(targetPath, size);
  if (targetInfo.unavailable) return { status: 'failed', error: STORAGE_DOWN_MESSAGE, unavailable: true };

  if (rootsEqual(sourceRoot, target) || sourcePath === targetPath) {
    if (!recordedRoot || !rootsEqual(recordedRoot, target) || previousRoot) {
      await stamp(table, row.id, target, null);
    }
    return { status: previousRoot ? 'moved' : 'already' };
  }

  if (targetInfo.mismatch) {
    return { status: 'failed', error: 'A file already in the new folder does not match this record' };
  }

  if (targetInfo.ok && sourcePath !== targetPath) {
    await stamp(table, row.id, target, rootsEqual(sourceRoot, target) ? null : sourceRoot);
    const removed = removeStored(name, sourceRoot);
    if (removed === 'unavailable') return { status: 'failed', error: STORAGE_DOWN_MESSAGE, unavailable: true };
    await stamp(table, row.id, target, null);
    return { status: 'moved' };
  }

  const sourceInfo = inspectStored(sourcePath, size);
  if (sourceInfo.unavailable) return { status: 'failed', error: STORAGE_DOWN_MESSAGE, unavailable: true };
  if (sourceInfo.mismatch) return { status: 'failed', error: 'Original file size does not match the record' };
  if (!sourceInfo.ok) return { status: 'missing', error: 'Original file is missing' };

  try {
    copyVerified(sourcePath, targetPath, sourceInfo.size);
  } catch (err) {
    if (err && err.code === 'ESIZE') {
      return { status: 'failed', error: 'Copied file size does not match the original' };
    }
    return { status: 'failed', error: STORAGE_DOWN_MESSAGE, unavailable: true };
  }

  const copied = inspectStored(targetPath, size);
  if (!copied.ok) return { status: 'failed', error: 'Copied file size does not match the original' };

  await stamp(table, row.id, target, sourceRoot);
  const removed = removeStored(name, sourceRoot);
  if (removed === 'unavailable') return { status: 'failed', error: STORAGE_DOWN_MESSAGE, unavailable: true };
  await stamp(table, row.id, target, null);
  return { status: 'moved' };
}

async function eachStoredRow(table) {
  return all(
    `SELECT id, stored_name, size_bytes, storage_root, storage_previous
     FROM ${table}
     WHERE stored_name IS NOT NULL AND length(trim(stored_name)) > 0
     ORDER BY id`
  );
}

async function countOutside() {
  const target = uploadDir();
  let count = 0;
  for (const table of FILE_TABLES) {
    let rows = [];
    try {
      rows = await all(
        `SELECT storage_root, storage_previous
         FROM ${table}
         WHERE stored_name IS NOT NULL AND length(trim(stored_name)) > 0`
      );
    } catch (err) {
      if (/no such (table|column)/i.test(String(err && err.message))) continue;
      throw err;
    }
    for (const row of rows) {
      if (textOrNull(row.storage_previous)) {
        count += 1;
        continue;
      }
      const root = textOrNull(row.storage_root) || legacyRoot();
      if (!rootsEqual(root, target)) count += 1;
    }
  }
  return count;
}

async function moveAll(actorId) {
  const ready = ensureUploadDir();
  if (!ready.ok) {
    return {
      unavailable: true,
      error: ready.error || STORAGE_DOWN_MESSAGE,
      target: uploadDir(),
      moved: 0,
      already: 0,
      missing: 0,
      failed: 0,
      errors: [],
    };
  }
  const target = uploadDir();
  const summary = {
    unavailable: false,
    error: null,
    target,
    moved: 0,
    already: 0,
    missing: 0,
    failed: 0,
    errors: [],
  };
  for (const table of FILE_TABLES) {
    const rows = await eachStoredRow(table);
    for (const row of rows) {
      const outcome = await moveRow(table, row, target);
      if (outcome.status === 'moved') summary.moved += 1;
      else if (outcome.status === 'already') summary.already += 1;
      else if (outcome.status === 'missing') {
        summary.missing += 1;
        if (summary.errors.length < 50) summary.errors.push({ table, id: row.id, message: outcome.error });
      } else {
        summary.failed += 1;
        if (summary.errors.length < 50) summary.errors.push({ table, id: row.id, message: outcome.error });
        if (outcome.unavailable) {
          summary.unavailable = true;
          summary.error = outcome.error || STORAGE_DOWN_MESSAGE;
          break;
        }
      }
    }
    if (summary.unavailable) break;
  }
  try {
    await activityLog.record(actorId, 'settings.file_storage_moved', 'system_settings', null, {
      moved: summary.moved,
      already: summary.already,
      missing: summary.missing,
      failed: summary.failed,
      message: `Moved ${summary.moved} existing file${summary.moved === 1 ? '' : 's'} to the current storage folder`,
    });
  } catch (err) {
    console.error('FILE STORAGE MOVE LOG ERROR:', err.message || err);
  }
  return summary;
}

module.exports = {
  FILE_TABLES,
  countOutside,
  moveAll,
};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function pathApi(root) {
  const text = String(root || '');
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('//')) return path.win32;
  return path.posix;
}

function unsupportedOnThisHost(root) {
  if (process.platform === 'win32') return false;
  return pathApi(root) === path.win32;
}

function hostError() {
  const error = new Error('This path is not available on this computer');
  error.code = 'ENOENT';
  return error;
}

// Local folder driver. The folder may be a disk path, a mapped drive, or a
// network share the operating system already mounted. A OneDrive or SharePoint
// driver would implement this same surface and register beside it.

function freeBytes(root) {
  try {
    const stat = fs.statfsSync(root);
    const block = Number(stat.bsize);
    const available = Number(stat.bavail);
    if (!Number.isFinite(block) || !Number.isFinite(available) || block < 0 || available < 0) return null;
    return block * available;
  } catch (err) {
    return null;
  }
}

function createLocalFolderDriver() {
  return {
    id: 'local',
    label: 'Local folder',

    status(root) {
      if (unsupportedOnThisHost(root)) {
        return {
          reachable: false,
          free_bytes: null,
          error: 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.',
        };
      }
      try {
        const stat = fs.statSync(root);
        if (!stat.isDirectory()) {
          return {
            reachable: false,
            free_bytes: null,
            error: 'File storage is unavailable. The storage folder is not a directory.',
          };
        }
        try {
          fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
        } catch (err) {
          return {
            reachable: false,
            free_bytes: null,
            error: 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.',
          };
        }
        return { reachable: true, free_bytes: freeBytes(root), error: null };
      } catch (err) {
        return {
          reachable: false,
          free_bytes: null,
          error: 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.',
        };
      }
    },

    ensureSync(root) {
      if (unsupportedOnThisHost(root)) throw hostError();
      fs.mkdirSync(root, { recursive: true });
    },

    probeSync(root) {
      if (unsupportedOnThisHost(root)) throw hostError();
      const api = pathApi(root);
      const probe = api.join(root, `.launchpad-write-test-${crypto.randomBytes(8).toString('hex')}`);
      const payload = Buffer.from(`launchpad ${Date.now()}`);
      try {
        fs.writeFileSync(probe, payload);
        const read = fs.readFileSync(probe);
        if (!read.equals(payload)) {
          const error = new Error('read-back mismatch');
          error.code = 'EREADBACK';
          throw error;
        }
        fs.unlinkSync(probe);
        if (fs.existsSync(probe)) {
          const error = new Error('test file remained');
          error.code = 'EPERM';
          throw error;
        }
      } catch (err) {
        try { fs.unlinkSync(probe); } catch (cleanupErr) { /* the probe reports the original failure */ }
        throw err;
      }
    },

    statSync(fullPath) {
      return fs.statSync(fullPath);
    },

    existsSync(fullPath) {
      try {
        return fs.existsSync(fullPath);
      } catch (err) {
        return false;
      }
    },

    writeFileSync(fullPath, data) {
      fs.writeFileSync(fullPath, data);
    },

    copyFileSync(source, dest) {
      fs.copyFileSync(source, dest);
    },

    renameSync(source, dest) {
      fs.renameSync(source, dest);
    },

    unlinkSync(fullPath) {
      fs.unlinkSync(fullPath);
    },

    createReadStream(fullPath) {
      return fs.createReadStream(fullPath);
    },
  };
}

const DRIVERS = {
  local: createLocalFolderDriver(),
};

function getStorageDriver(id) {
  const raw = id == null || String(id).trim() === ''
    ? (process.env.FILE_STORAGE_DRIVER || 'local')
    : id;
  const key = String(raw).trim().toLowerCase() || 'local';
  const driver = DRIVERS[key];
  if (!driver) {
    const error = new Error(
      `Storage driver "${key}" is not installed. Only the local folder driver is available. A OneDrive or SharePoint driver can be added later.`
    );
    error.status = 400;
    error.code = 'STORAGE_DRIVER';
    return { driver: null, error };
  }
  return { driver, error: null };
}

module.exports = {
  createLocalFolderDriver,
  getStorageDriver,
};

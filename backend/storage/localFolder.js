const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MARKER_FILE = '.launchpad-storage';
const CHECK_TIMEOUT_MS = 5000;

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

function parentMissingError() {
  const error = new Error('The parent folder does not exist');
  error.code = 'ENOENT';
  error.reason = 'parent';
  return error;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Storage folder check timed out');
      error.code = 'ETIMEDOUT';
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
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

function markerPath(root) {
  return pathApi(root).join(root, MARKER_FILE);
}

function readMarkerSync(root) {
  try {
    const data = fs.readFileSync(markerPath(root));
    if (!data || data.length > 256) return null;
    const text = data.toString('utf8').trim();
    if (!/^[a-f0-9]{32}$/.test(text)) return null;
    return text;
  } catch (err) {
    return null;
  }
}

function writeMarkerSync(root, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) {
    const error = new Error('marker id is invalid');
    error.code = 'EINVAL';
    throw error;
  }
  const api = pathApi(root);
  const target = markerPath(root);
  const tmp = api.join(root, `.${MARKER_FILE}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, `${id}\n`, { flag: 'w' });
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* the rename error is the one that matters */ }
    throw err;
  }
}

function createParentThenFolderSync(root) {
  if (unsupportedOnThisHost(root)) throw hostError();
  const api = pathApi(root);
  const parent = api.dirname(root);
  if (!parent || parent === root) throw parentMissingError();
  let parentStat;
  try {
    parentStat = fs.statSync(parent);
  } catch (err) {
    throw parentMissingError();
  }
  if (!parentStat.isDirectory()) {
    const error = new Error('The parent folder is not a directory');
    error.code = 'ENOTDIR';
    throw error;
  }
  try {
    fs.mkdirSync(root);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) {
      const error = new Error('Storage folder is not a directory');
      error.code = 'ENOTDIR';
      throw error;
    }
  }
}

async function createParentThenFolder(root) {
  if (unsupportedOnThisHost(root)) throw hostError();
  const api = pathApi(root);
  const parent = api.dirname(root);
  if (!parent || parent === root) throw parentMissingError();
  let parentStat;
  try {
    parentStat = await fs.promises.stat(parent);
  } catch (err) {
    throw parentMissingError();
  }
  if (!parentStat.isDirectory()) {
    const error = new Error('The parent folder is not a directory');
    error.code = 'ENOTDIR';
    throw error;
  }
  try {
    await fs.promises.mkdir(root);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory()) {
      const error = new Error('Storage folder is not a directory');
      error.code = 'ENOTDIR';
      throw error;
    }
  }
}

async function probeFolder(root) {
  if (unsupportedOnThisHost(root)) throw hostError();
  const api = pathApi(root);
  const probe = api.join(root, `.launchpad-write-test-${crypto.randomBytes(8).toString('hex')}`);
  const payload = Buffer.from(`launchpad ${Date.now()}`);
  try {
    await fs.promises.writeFile(probe, payload);
    const read = await fs.promises.readFile(probe);
    if (!read.equals(payload)) {
      const error = new Error('read-back mismatch');
      error.code = 'EREADBACK';
      throw error;
    }
    await fs.promises.unlink(probe);
  } catch (err) {
    try { await fs.promises.unlink(probe); } catch (cleanupErr) { /* the probe reports the original failure */ }
    throw err;
  }
}

function hashFileSync(fullPath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(fullPath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function createLocalFolderDriver() {
  return {
    id: 'local',
    label: 'Local folder',

    status(root, expectedMarkerId) {
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
        if (expectedMarkerId !== undefined) {
          const marker = readMarkerSync(root);
          if (!expectedMarkerId || marker !== expectedMarkerId) {
            return {
              reachable: false,
              free_bytes: null,
              error: 'File storage is unavailable. The storage folder cannot be reached, so uploads are paused.',
            };
          }
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

    // Kept for the driver contract. Creates only the final folder, and only
    // when the parent already exists. It does not create missing parents.
    ensureSync(root) {
      createParentThenFolderSync(root);
    },

    async checkNewFolder(root) {
      await withTimeout((async () => {
        await createParentThenFolder(root);
        await probeFolder(root);
      })(), CHECK_TIMEOUT_MS);
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

    readMarkerSync,
    writeMarkerSync,
    hashFileSync,

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
  MARKER_FILE,
  CHECK_TIMEOUT_MS,
  createLocalFolderDriver,
  getStorageDriver,
};

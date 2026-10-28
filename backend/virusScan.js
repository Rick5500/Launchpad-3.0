// Pluggable malware scan. The default talks to clamd over TCP (INSTREAM).
// A missing scanner, a timeout, a socket error, or a response that is not a
// clear clean/infected/encrypted verdict stays an error or inconclusive result.
// Callers must leave the file quarantined unless the verdict is clean.

const net = require('net');

const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 20000;
const CHUNK = 64 * 1024;

let scannerOverride = null;

function setScanner(fn) {
  scannerOverride = typeof fn === 'function' ? fn : null;
}

function resetScanner() {
  scannerOverride = null;
}

function clamdHost() {
  return String(process.env.CLAMD_HOST || '').trim();
}

function clamdPort() {
  const parsed = Number(process.env.CLAMD_PORT || DEFAULT_PORT);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return DEFAULT_PORT;
  return parsed;
}

function timeoutMs() {
  const parsed = Number(process.env.CLAMD_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 500) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 120000);
}

function parseClamd(text) {
  const line = String(text || '').replace(/\0/g, '').trim();
  if (!line) return { verdict: 'inconclusive', detail: 'The scanner returned an empty result' };
  if (/encrypted/i.test(line)) return { verdict: 'encrypted', detail: line.slice(0, 300) };
  if (/:\s*OK\s*$/i.test(line)) return { verdict: 'clean', detail: line.slice(0, 300) };
  if (/FOUND/i.test(line)) return { verdict: 'infected', detail: line.slice(0, 300) };
  if (/ERROR|timeout/i.test(line)) return { verdict: 'error', detail: line.slice(0, 300) };
  return { verdict: 'inconclusive', detail: line.slice(0, 300) };
}

function scanWithClamd(buffer) {
  const host = clamdHost();
  if (!host) {
    return Promise.resolve({ verdict: 'error', detail: 'The virus scanner is not configured' });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = net.connect({ host, port: clamdPort() });
    const timer = setTimeout(() => {
      socket.destroy();
      finish({ verdict: 'error', detail: 'The virus scanner timed out' });
    }, timeoutMs());
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish({ verdict: 'error', detail: 'The virus scanner is unavailable' });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      finish(parseClamd(response));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < buffer.length; offset += CHUNK) {
        const slice = buffer.subarray(offset, Math.min(buffer.length, offset + CHUNK));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(slice.length, 0);
        socket.write(header);
        socket.write(slice);
      }
      const end = Buffer.alloc(4);
      end.writeUInt32BE(0, 0);
      socket.write(end);
    });
  });
}

async function scanBuffer(buffer) {
  if (!buffer || !buffer.length) {
    return { verdict: 'error', detail: 'There is nothing to scan' };
  }
  try {
    if (scannerOverride) {
      const result = await scannerOverride(buffer);
      if (!result || !result.verdict) return { verdict: 'inconclusive', detail: 'The scanner returned no verdict' };
      const verdict = String(result.verdict);
      if (!['clean', 'infected', 'encrypted', 'error', 'inconclusive'].includes(verdict)) {
        return { verdict: 'inconclusive', detail: 'The scanner returned an unknown verdict' };
      }
      return { verdict, detail: String(result.detail || '').slice(0, 300) };
    }
    return await scanWithClamd(buffer);
  } catch (err) {
    return { verdict: 'error', detail: 'The virus scanner failed' };
  }
}

module.exports = {
  setScanner,
  resetScanner,
  parseClamd,
  scanBuffer,
  clamdHost,
  clamdPort,
};

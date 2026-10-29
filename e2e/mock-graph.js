// Local stand-in for Microsoft Graph. It never calls Microsoft.
// The inbox is whatever the tests POST to /__e2e/messages.

const http = require('http');

function sendJson(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': raw.length,
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function startMockGraph() {
  const inbox = [];
  const accessToken = 'e2e-graph-token';

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (err) {
      sendJson(res, 400, { error: { message: 'bad url' } });
      return;
    }

    if (url.pathname === '/__e2e/messages' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const added = Array.isArray(body) ? body : (body && body.messages) || [];
        for (const message of added) inbox.push(message);
        sendJson(res, 200, { ok: true, count: inbox.length });
      } catch (err) {
        sendJson(res, 400, { error: 'invalid json' });
      }
      return;
    }

    if (url.pathname === '/__e2e/reset' && req.method === 'POST') {
      inbox.length = 0;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/oauth2/v2.0/token')) {
      req.resume();
      sendJson(res, 200, {
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: accessToken,
      });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { message: 'method not allowed' } });
      return;
    }

    const header = String(req.headers.authorization || '');
    if (header !== `Bearer ${accessToken}`) {
      sendJson(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'bad token' } });
      return;
    }

    const delta = url.pathname.endsWith('/messages/delta') || url.pathname === '/v1.0/delta';
    if (delta) {
      const port = server.address().port;
      sendJson(res, 200, {
        value: inbox.filter((message) => !message['@removed']),
        '@odata.deltaLink': `http://127.0.0.1:${port}/v1.0/delta`,
      });
      return;
    }

    if (url.pathname.includes('/messages/') && url.searchParams.get('$select') === 'internetMessageHeaders') {
      const id = decodeURIComponent(url.pathname.split('/messages/')[1].split('?')[0]);
      const message = inbox.find((row) => row.id === id);
      sendJson(res, 200, {
        internetMessageHeaders: (message && message.internetMessageHeaders) || [],
      });
      return;
    }

    if (url.pathname.endsWith('/attachments')) {
      sendJson(res, 200, { value: [] });
      return;
    }

    sendJson(res, 404, { error: { message: 'not found' } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        base: `http://127.0.0.1:${port}`,
      });
    });
  });
}

module.exports = { startMockGraph };

// Starts the mock mailbox, seeds a throwaway SQLite file from init_db.js,
// and serves the production frontend build with NODE_ENV=test.
// Mail uses nodemailer's JSON transport. Nothing is delivered.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const c = require('./constants');
const { startMockGraph } = require('./mock-graph');
const { assertThrowawayDatabase, seedDatabase } = require('./seed');

const root = path.join(__dirname, '..');
const runtimeDir = path.join(root, 'e2e', '.runtime');
const databaseFile = path.join(runtimeDir, 'launchpad.db');
const uploadDir = path.join(runtimeDir, 'uploads');

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

function frontendBuildIsStale() {
  const index = path.join(root, 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(index)) return true;
  const built = fs.statSync(index).mtimeMs;
  const src = path.join(root, 'frontend', 'src');
  return newestMtime(src) > built;
}

function buildFrontend() {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: path.join(root, 'frontend'),
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`frontend build exited ${code}`));
    });
  });
}

async function main() {
  assertThrowawayDatabase(databaseFile);
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_FILE = databaseFile;
  process.env.PORT = String(c.PORT);
  process.env.DELIVERY_TIMEZONE = 'America/New_York';
  process.env.UPLOAD_DIR = uploadDir;
  process.env.MAIL_TRANSPORT = 'json';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = '2525';
  process.env.SMTP_FROM = c.SMTP_FROM;
  process.env.SMTP_USER = 'e2e';
  process.env.SMTP_PASS = 'e2e-not-a-secret';
  process.env.SMTP_TIMEOUT_MS = '1000';
  process.env.PUBLIC_APP_URL = c.BASE_URL;
  process.env.M365_POLL_SECONDS = '60';
  process.env.M365_HTTP_TIMEOUT_MS = '8000';
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  delete process.env.EMAIL_NOTIFICATIONS;

  if (frontendBuildIsStale()) {
    await buildFrontend();
  }

  const graph = await startMockGraph();
  process.env.M365_TENANT_ID = 'e2e-tenant';
  process.env.M365_CLIENT_ID = 'e2e-client';
  process.env.M365_CLIENT_SECRET = 'e2e-secret-not-real';
  process.env.M365_MAILBOX = c.MAILBOX;
  process.env.M365_FOLDER = 'Inbox';
  process.env.M365_LOGIN_BASE_URL = graph.base;
  process.env.M365_GRAPH_BASE_URL = graph.base;

  const fixture = await seedDatabase(databaseFile);
  const runtime = {
    ...fixture,
    baseURL: c.BASE_URL,
    graphBase: graph.base,
  };
  fs.writeFileSync(path.join(runtimeDir, 'runtime.json'), JSON.stringify(runtime, null, 2));

  require(path.join(root, 'backend', 'server.js'));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

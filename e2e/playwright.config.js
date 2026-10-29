const path = require('path');
const { PORT } = require('./constants');

const root = path.join(__dirname, '..');

module.exports = {
  testDir: path.join(__dirname, 'tests'),
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.join(root, 'playwright-report') }],
  ],
  outputDir: path.join(root, 'test-results'),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    viewport: { width: 1400, height: 900 },
    actionTimeout: 15000,
  },
  webServer: {
    command: 'node e2e/start-server.js',
    cwd: root,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 180000,
    reuseExistingServer: false,
  },
};

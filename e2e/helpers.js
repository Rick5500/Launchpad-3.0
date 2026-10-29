const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');
const c = require('./constants');
const { nextWeekday } = require('./dates');

const root = path.join(__dirname, '..');

function runtime() {
  const file = path.join(root, 'e2e', '.runtime', 'runtime.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function openDb() {
  const sqlite3 = require(path.join(root, 'backend', 'node_modules', 'sqlite3')).verbose();
  const info = runtime();
  const db = new sqlite3.Database(info.databaseFile);
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  return { get, all, close };
}

async function login(page, user) {
  await page.goto('/login');
  // A signed-in visit to /login is sent back to the dashboard. Clear the
  // stored session so a later login in the same tab can use the form.
  await page.evaluate(() => {
    localStorage.removeItem('lp_token');
    sessionStorage.removeItem('lp_csrf');
  });
  await page.goto('/login');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByRole('button', { name: 'Log Out' }).first()).toBeVisible({ timeout: 20000 });
  const auth = await session(page);
  const me = await page.request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  expect(me.status(), await me.text()).toBe(200);
}

async function session(page) {
  return page.evaluate(() => ({
    token: localStorage.getItem('lp_token'),
    csrf: sessionStorage.getItem('lp_csrf'),
  }));
}

async function api(page, urlPath, { method = 'GET', data, csrf = true } = {}) {
  const auth = await session(page);
  const headers = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (csrf && auth.csrf) headers['X-CSRF-Token'] = auth.csrf;
  const response = await page.request.fetch(urlPath, { method, headers, data });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      body = text;
    }
  }
  return { status: response.status(), body, text };
}

function labelled(page, role, label) {
  return page.getByRole(role, { name: new RegExp(`^${label}\\b`) });
}

async function chooseSelect(page, label, option) {
  await labelled(page, 'combobox', label).click();
  const choice = page.getByRole('option', { name: option, exact: true });
  await expect(choice).toBeVisible();
  await choice.click();
}

async function fillStaffOrder(page, { customerName, projectName, notes, confirmInbound = false }) {
  await expect(labelled(page, 'combobox', 'Customer')).toBeVisible();
  await chooseSelect(page, 'Customer', customerName);
  if (confirmInbound) {
    await page.locator('#confirm-customer').check();
    await page.locator('#confirm-recipient').check();
  }
  await labelled(page, 'textbox', 'Project Name').fill(projectName);
  await chooseSelect(page, 'Payment Method', 'Cash');
  await page.getByRole('checkbox', { name: 'Archive File Request' }).click();
  await chooseSelect(page, 'Originals Source', 'Hardcopy or digital media provided');
  await labelled(page, 'textbox', 'Special instructions').fill(notes);
  await page.locator('#order-due-date').fill(nextWeekday());
  await chooseSelect(page, 'Due Time', '10:00 AM');
  await page.getByTestId('submit-order').click();
}

async function checkMailbox(page) {
  const done = page.waitForResponse((response) => (
    response.url().includes('/api/inbound-emails/sync') && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: 'Check now' }).click();
  const response = await done;
  expect(response.status(), await response.text()).toBe(200);
}

module.exports = {
  c,
  runtime,
  openDb,
  login,
  session,
  api,
  chooseSelect,
  fillStaffOrder,
  checkMailbox,
  labelled,
};

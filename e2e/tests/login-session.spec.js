const { test, expect } = require('@playwright/test');
const { c, login, session, api } = require('../helpers');

test('a wrong password is rejected', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill(c.ADMIN.username);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('invalid credentials')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  const stored = await session(page);
  expect(stored.token).toBeFalsy();
});

test('logout invalidates the session', async ({ page }) => {
  await login(page, c.OPERATOR);
  const before = await session(page);
  expect(before.token).toBeTruthy();

  const logoutResponse = page.waitForResponse((response) => (
    response.url().includes('/api/auth/logout') && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: 'Log Out' }).first().click();
  const loggedOut = await logoutResponse;
  expect(loggedOut.status()).toBe(200);
  await expect(page).toHaveURL(/\/login/);

  const me = await page.request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${before.token}` },
  });
  expect(me.status()).toBe(401);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a CSRF-protected endpoint rejects a request without a token', async ({ page }) => {
  await login(page, c.ADMIN);
  const auth = await session(page);
  const blocked = await page.request.post('/api/inbound-emails/sync', {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  expect(blocked.status()).toBe(403);
  const body = await blocked.json();
  expect(body.error).toMatch(/CSRF/i);

  const allowed = await api(page, '/api/inbound-emails/sync', { method: 'POST' });
  expect(allowed.status).not.toBe(403);
  expect(JSON.stringify(allowed.body)).not.toMatch(/CSRF/i);
});

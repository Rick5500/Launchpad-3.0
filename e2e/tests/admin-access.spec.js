const { test, expect } = require('@playwright/test');
const { c, login, api } = require('../helpers');

const PAGES = [
  { path: '/users', heading: 'Users', nav: 'Users' },
  { path: '/locations', heading: 'Locations', nav: 'Locations' },
  { path: '/settings', heading: 'System Settings', nav: 'System Settings' },
  { path: '/services', heading: 'Services', nav: 'Services' },
  { path: '/admin/departments', heading: 'Department Administration', nav: 'Departments' },
  { path: '/activity-log', heading: 'Activity Log', nav: 'Activity Log' },
  { path: '/barcode-settings', heading: 'Barcode Settings', nav: 'Barcode Settings' },
];

test('an admin can open users, locations, and settings', async ({ page }) => {
  await login(page, c.ADMIN);
  for (const item of PAGES) {
    await expect(page.getByRole('button', { name: item.nav, exact: true })).toBeVisible();
  }
  for (const item of PAGES) {
    await page.goto(item.path);
    await expect(page).toHaveURL(new RegExp(`${item.path.replace('/', '\\/')}$`));
    await expect(page.getByRole('heading', { name: item.heading, exact: true, level: 4 })).toBeVisible();
  }

  const users = await api(page, '/api/users?limit=100');
  expect(users.status).toBe(200);
  expect(JSON.stringify(users.body)).not.toContain('password_hash');
  expect((users.body.users || []).some((row) => row.username === c.OPERATOR.username)).toBe(true);

  const settings = await api(page, '/api/settings');
  expect(settings.status).toBe(200);
  expect(settings.body.letterhead || settings.body.company_name || settings.body).toBeTruthy();

  const locations = await api(page, '/api/locations');
  expect(locations.status).toBe(200);
  const names = (locations.body.locations || []).map((row) => row.name);
  expect(names).toEqual(expect.arrayContaining(['Raleigh', 'Hickory']));
});

for (const staff of [c.MANAGER_RALEIGH, c.OPERATOR]) {
  test(`${staff.username} is refused the admin screens and the admin APIs`, async ({ page }) => {
    await login(page, staff);
    for (const item of PAGES) {
      await expect(page.getByRole('button', { name: item.nav, exact: true })).toHaveCount(0);
    }
    for (const item of PAGES) {
      await page.goto(item.path);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { name: item.heading, exact: true, level: 4 })).toHaveCount(0);
    }

    expect((await api(page, '/api/users')).status).toBe(403);
    expect((await api(page, '/api/settings')).status).toBe(403);
    expect((await api(page, '/api/services')).status).toBe(403);
    expect((await api(page, '/api/activity')).status).toBe(403);
    expect((await api(page, '/api/notifications/settings')).status).toBe(403);
    const createLocation = await api(page, '/api/locations', {
      method: 'POST',
      data: { name: 'Should Not Create', address: '1 Test', phone: '919-555-0100' },
    });
    expect(createLocation.status).toBe(403);
  });
}

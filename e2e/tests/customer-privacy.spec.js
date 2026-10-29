const { test, expect } = require('@playwright/test');
const { c, login, api, runtime } = require('../helpers');

// PR #51 (https://github.com/Rick5500/Launchpad-3.0/pull/51) is not on master.
// It scopes customer mobile numbers to a manager's own shop, hides them from a
// manager with no shop, and omits SMS recipients on order detail for operators
// and for managers whose shop is not the customer's shop.
// Tests that need that behaviour are test.fixme. Remove fixme after #51 merges.
// The tests that run here assert the privacy behaviour master already enforces.

function noticesOf(body) {
  return (body && body.order && body.order.customer_notices) || [];
}

test('an operator does not receive customer mobile numbers from the API or the pages they can open', async ({ page }) => {
  const data = runtime();
  await login(page, c.OPERATOR);

  await expect(page.getByRole('button', { name: 'Customers', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Users', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(c.CUSTOMER_RALEIGH.mobile);
  await expect(page.locator('body')).not.toContainText(c.CUSTOMER_HICKORY.mobile);
  await expect(page.locator('body')).not.toContainText(c.TRANSFER_SMS);

  await page.goto('/customers');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Customers', exact: true, level: 4 })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(c.CUSTOMER_RALEIGH.mobile);

  const directory = await api(page, '/api/customers');
  expect(directory.status).toBe(403);
  expect(directory.text).not.toContain(c.CUSTOMER_RALEIGH.mobile);
  expect(directory.text).not.toContain(c.CUSTOMER_HICKORY.mobile);

  const lookup = await api(page, '/api/customers/lookup');
  expect(lookup.status).toBe(200);
  expect(lookup.text).not.toContain('mobile_phone');
  expect(lookup.text).not.toContain('sms_opt_in');
  expect(lookup.text).not.toContain(c.CUSTOMER_RALEIGH.mobile);
  expect(lookup.text).not.toContain(c.CUSTOMER_HICKORY.mobile);
  expect(lookup.text).not.toContain('password_hash');

  const users = await api(page, '/api/users');
  expect(users.status).toBe(403);
  expect(users.text).not.toContain(c.CUSTOMER_RALEIGH.mobile);
});

test('an admin and the customer home-shop manager can see that customer mobile', async ({ page }) => {
  const data = runtime();
  await login(page, c.ADMIN);
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: 'Customers', exact: true, level: 4 })).toBeVisible();
  await expect(page.locator('body')).toContainText(c.CUSTOMER_RALEIGH.mobile);
  await expect(page.locator('body')).toContainText(c.CUSTOMER_HICKORY.mobile);

  const directory = await api(page, '/api/customers');
  expect(directory.status).toBe(200);
  const raleigh = directory.body.find((row) => row.id === data.users.customerRaleigh);
  const hickory = directory.body.find((row) => row.id === data.users.customerHickory);
  expect(raleigh.mobile_phone).toBe(c.CUSTOMER_RALEIGH.mobile);
  expect(raleigh.sms_opt_in).toBe(true);
  expect(hickory.mobile_phone).toBe(c.CUSTOMER_HICKORY.mobile);
  expect(JSON.stringify(directory.body)).not.toContain('password_hash');

  await page.goto(`/orders/${data.raleigh.orderId}`);
  const notices = page.getByTestId('order-customer-notices');
  await expect(notices).toContainText(c.CUSTOMER_RALEIGH.mobile);
  await expect(notices).toContainText(c.EMAIL_RECIPIENT);
  const order = await api(page, `/api/orders/${data.raleigh.orderId}`);
  expect(order.status).toBe(200);
  expect(noticesOf(order.body).some((row) => row.channel === 'sms' && row.recipient === c.CUSTOMER_RALEIGH.mobile)).toBe(true);
  expect(noticesOf(order.body).some((row) => row.channel === 'email' && row.recipient === c.EMAIL_RECIPIENT)).toBe(true);

  await login(page, c.MANAGER_RALEIGH);
  await page.goto('/customers');
  await expect(page.locator('body')).toContainText(c.CUSTOMER_RALEIGH.mobile);
  const ownShop = await api(page, '/api/customers');
  expect(ownShop.status).toBe(200);
  const own = ownShop.body.find((row) => row.id === data.users.customerRaleigh);
  expect(own.mobile_phone).toBe(c.CUSTOMER_RALEIGH.mobile);

  await page.goto(`/orders/${data.raleigh.orderId}`);
  await expect(page.getByTestId('order-customer-notices')).toContainText(c.CUSTOMER_RALEIGH.mobile);
  await expect(page.getByTestId('order-customer-notices')).toContainText(c.EMAIL_RECIPIENT);
});

test('a manager at another shop cannot open the order, so its private notice is not shown', async ({ page }) => {
  const data = runtime();
  await login(page, c.MANAGER_HICKORY);
  await page.goto(`/orders/${data.raleigh.orderId}`);
  await expect(page.getByText('Order not found')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(c.CUSTOMER_RALEIGH.mobile);
  await expect(page.locator('body')).not.toContainText(c.TRANSFER_SMS);

  const order = await api(page, `/api/orders/${data.raleigh.orderId}`);
  expect(order.status).toBe(404);
  expect(order.text).not.toContain(c.CUSTOMER_RALEIGH.mobile);
  expect(order.text).not.toContain(c.TRANSFER_SMS);
});

test.fixme('PR #51: a manager does not see mobile numbers for another shop', async ({ page }) => {
  const data = runtime();
  await login(page, c.MANAGER_RALEIGH);
  await page.goto('/customers');
  await expect(page.locator('body')).toContainText(c.CUSTOMER_RALEIGH.mobile);
  await expect(page.locator('body')).not.toContainText(c.CUSTOMER_HICKORY.mobile);

  const directory = await api(page, '/api/customers');
  expect(directory.status).toBe(200);
  expect(directory.text).not.toContain(c.CUSTOMER_HICKORY.mobile);
  const other = directory.body.find((row) => row.id === data.users.customerHickory);
  expect(!other || !other.mobile_phone).toBe(true);

  const texting = await api(page, `/api/customers/${data.users.customerHickory}/texting`, {
    method: 'PUT',
    data: { mobile_phone: '919-555-0198', sms_opt_in: false },
  });
  expect(texting.status).toBe(404);
});

test.fixme('PR #51: a manager with no shop sees no customer mobile numbers', async ({ page }) => {
  const data = runtime();
  await login(page, c.MANAGER_NONE);
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: 'Customers', exact: true, level: 4 })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(c.CUSTOMER_RALEIGH.mobile);
  await expect(page.locator('body')).not.toContainText(c.CUSTOMER_HICKORY.mobile);

  const directory = await api(page, '/api/customers');
  expect(directory.status).toBe(200);
  expect(directory.text).not.toContain(c.CUSTOMER_RALEIGH.mobile);
  expect(directory.text).not.toContain(c.CUSTOMER_HICKORY.mobile);
  for (const row of directory.body) {
    expect(row.mobile_phone || '').toBe('');
  }

  const texting = await api(page, `/api/customers/${data.users.customerRaleigh}/texting`, {
    method: 'PUT',
    data: { mobile_phone: '', sms_opt_in: false },
  });
  expect(texting.status).toBe(404);
});

test.fixme('PR #51: order detail hides SMS recipients from an operator, another shop, and a manager with no shop', async ({ page }) => {
  const data = runtime();
  const viewers = [c.OPERATOR, c.MANAGER_RALEIGH, c.MANAGER_NONE];
  for (const viewer of viewers) {
    await login(page, viewer);
    await page.goto(`/orders/${data.transferred.orderId}`);
    await expect(page.getByText(c.TRANSFER_PROJECT).first()).toBeVisible();
    const panel = page.getByTestId('order-customer-notices');
    await expect(panel).toContainText(c.EMAIL_RECIPIENT);
    await expect(panel).not.toContainText(c.TRANSFER_SMS);
    await expect(panel).not.toContainText(c.CUSTOMER_HICKORY.mobile);

    const order = await api(page, `/api/orders/${data.transferred.orderId}`);
    expect(order.status).toBe(200);
    expect(order.text).not.toContain(c.TRANSFER_SMS);
    expect(order.text).not.toContain(c.CUSTOMER_HICKORY.mobile);
    const sms = noticesOf(order.body).filter((row) => row.channel === 'sms');
    expect(sms.every((row) => !row.recipient)).toBe(true);
    expect(noticesOf(order.body).some((row) => row.channel === 'email' && row.recipient === c.EMAIL_RECIPIENT)).toBe(true);
  }

  await login(page, c.ADMIN);
  await page.goto(`/orders/${data.transferred.orderId}`);
  await expect(page.getByTestId('order-customer-notices')).toContainText(c.TRANSFER_SMS);
  const adminOrder = await api(page, `/api/orders/${data.transferred.orderId}`);
  expect(noticesOf(adminOrder.body).some((row) => row.channel === 'sms' && row.recipient === c.TRANSFER_SMS)).toBe(true);
});

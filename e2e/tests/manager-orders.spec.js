const { test, expect } = require('@playwright/test');
const { c, login, api, runtime, openDb, fillStaffOrder } = require('../helpers');

test('a manager can create an order, edit it, and see the values after reload', async ({ page }) => {
  await login(page, c.MANAGER_RALEIGH);
  await page.goto('/order');
  await expect(page.getByRole('heading', { name: 'Create Order', exact: true, level: 1 })).toBeVisible();

  const project = `Manager created ${Date.now()}`;
  const notes = 'Hold the set at will call for the functional test.';
  await fillStaffOrder(page, {
    customerName: c.CUSTOMER_RALEIGH.displayName,
    projectName: project,
    notes,
  });

  await expect(page.getByTestId('order-number')).toBeVisible();
  const orderNumber = (await page.getByTestId('order-number').innerText()).replace('Order #:', '').trim();
  expect(orderNumber).toMatch(/^\d{8}-\d{3}$/);
  await page.getByRole('button', { name: 'View Submitted Order' }).click();
  await expect(page.getByText(project).first()).toBeVisible();
  await expect(page.getByText(notes).first()).toBeVisible();

  await page.reload();
  await expect(page.getByText(project).first()).toBeVisible();
  await expect(page.getByText(notes).first()).toBeVisible();

  await page.getByRole('combobox', { name: /^Order status\b/ }).click();
  await page.getByRole('option', { name: 'Ready for Pickup', exact: true }).click();
  await page.getByTestId('pickup-status-save').click();
  await expect(page.getByTestId('order-ready-banner')).toHaveText('Ready for pickup');

  await page.reload();
  await expect(page.getByTestId('order-ready-banner')).toHaveText('Ready for pickup');
  await expect(page.getByText(project).first()).toBeVisible();
  await expect(page.getByText(notes).first()).toBeVisible();

  const orderId = new URL(page.url()).pathname.split('/').pop();
  const loaded = await api(page, `/api/orders/${orderId}`);
  expect(loaded.status).toBe(200);
  expect(loaded.body.order.status).toBe('Ready for Pickup');
  expect(loaded.body.order.project_name).toBe(project);
  expect(loaded.body.order.notes).toBe(notes);
  expect(loaded.body.order.payment_method).toBe('Cash');
});

test('a manager cannot edit an order at another shop', async ({ page }) => {
  const data = runtime();
  await login(page, c.MANAGER_HICKORY);

  await page.goto(`/orders/${data.raleigh.orderId}`);
  await expect(page.getByText('Order not found')).toBeVisible();
  await expect(page.getByText(c.RALEIGH_PROJECT)).toHaveCount(0);
  await expect(page.getByText(c.RALEIGH_DESCRIPTION)).toHaveCount(0);

  const order = await api(page, `/api/orders/${data.raleigh.orderId}`);
  expect(order.status).toBe(404);

  await page.goto(`/work-orders/${data.raleigh.workOrderId}/edit`);
  await expect(page.getByText('Unable to load work order')).toBeVisible();
  await expect(page.getByText(c.RALEIGH_DESCRIPTION)).toHaveCount(0);

  const update = await api(page, `/api/workorders/${data.raleigh.workOrderId}`, {
    method: 'PUT',
    data: {
      customer_id: data.users.customerRaleigh,
      description: 'Hickory manager should not save this',
      quantity: 1,
      status: 'open',
      department: 'Archive File',
      external_id: c.RALEIGH_EXTERNAL_ID,
      priority: 'Normal',
      notes: 'unauthorized edit',
    },
  });
  expect(update.status).toBe(404);

  const transfer = await api(page, `/api/orders/${data.raleigh.orderId}/location`, {
    method: 'POST',
    data: { location_id: data.locations.hickory },
  });
  expect(transfer.status).toBe(404);

  const db = openDb();
  try {
    const row = await db.get(`SELECT description, notes FROM work_orders WHERE id = ?`, [data.raleigh.workOrderId]);
    expect(row.description).not.toBe('Hickory manager should not save this');
    expect(row.notes).not.toBe('unauthorized edit');
    const orderRow = await db.get(`SELECT location_id, project_name FROM orders WHERE id = ?`, [data.raleigh.orderId]);
    expect(orderRow.location_id).toBe(data.locations.raleigh);
    expect(orderRow.project_name).toBe(c.RALEIGH_PROJECT);
  } finally {
    await db.close();
  }
});

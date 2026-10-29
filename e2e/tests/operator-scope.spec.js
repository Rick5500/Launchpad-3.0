const { test, expect } = require('@playwright/test');
const { c, login, api, runtime, openDb } = require('../helpers');

async function searchBoard(page, text) {
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  await page.getByTestId('board-search').locator('input').fill(text);
}

test('a production operator sees only work orders at their shop', async ({ page }) => {
  const data = runtime();
  await login(page, c.OPERATOR);

  await searchBoard(page, c.RALEIGH_EXTERNAL_ID);
  const raleighRow = page.getByTestId(`board-row-${c.RALEIGH_EXTERNAL_ID}`);
  await expect(raleighRow).toBeVisible();
  await expect(raleighRow).toContainText(c.RALEIGH_PROJECT);

  await searchBoard(page, c.HICKORY_EXTERNAL_ID);
  await expect(page.getByTestId(`board-row-${c.HICKORY_EXTERNAL_ID}`)).toHaveCount(0);
  await expect(page.getByText(c.HICKORY_PROJECT)).toHaveCount(0);
  await expect(page.getByText(c.HICKORY_DESCRIPTION)).toHaveCount(0);

  const list = await api(page, '/api/workorders');
  expect(list.status).toBe(200);
  const ids = (list.body || []).map((row) => row.external_id);
  expect(ids).toContain(c.RALEIGH_EXTERNAL_ID);
  expect(ids).not.toContain(c.HICKORY_EXTERNAL_ID);
  expect(list.body.length).toBeGreaterThan(0);
  for (const row of list.body) {
    const shop = row.location_id != null ? row.location_id : row.order_location_id;
    expect(shop).toBe(data.locations.raleigh);
  }
});

test('an operator can scan an authorized work order and that scan moves it', async ({ page }) => {
  await login(page, c.OPERATOR);
  await page.goto('/scan');
  await expect(page.getByRole('heading', { name: 'Scan', exact: true, level: 4 })).toBeVisible();
  await page.getByRole('combobox', { name: /^Location\b/ }).click();
  await page.getByRole('option', { name: 'Quality', exact: true }).click();
  await page.getByRole('textbox', { name: /^Barcode\b/ }).fill(c.RALEIGH_EXTERNAL_ID);
  await page.getByRole('button', { name: 'Record scan' }).click();
  await expect(page.getByRole('alert')).toContainText(`Recorded ${c.RALEIGH_EXTERNAL_ID}. Moved from Archive File to Quality`);

  const db = openDb();
  try {
    const row = await db.get(`SELECT department FROM work_orders WHERE external_id = ?`, [c.RALEIGH_EXTERNAL_ID]);
    expect(row.department).toBe('Quality');
  } finally {
    await db.close();
  }
});

test('another shop work order is refused from the page, the scan, and the API', async ({ page }) => {
  const data = runtime();
  await login(page, c.OPERATOR);

  await page.goto(`/work-orders/${data.hickory.workOrderId}`);
  await expect(page.getByText('Work order not found')).toBeVisible();
  await expect(page.getByText(c.HICKORY_DESCRIPTION)).toHaveCount(0);
  await expect(page.getByText(c.HICKORY_PROJECT)).toHaveCount(0);

  const detail = await api(page, `/api/workorders/${data.hickory.workOrderId}`);
  expect(detail.status).toBe(404);

  const scan = await api(page, '/api/barcode', {
    method: 'POST',
    data: { scanned_value: c.HICKORY_EXTERNAL_ID, location: 'Quality' },
  });
  expect(scan.status).toBe(404);

  const move = await api(page, `/api/workorders/${data.hickory.workOrderId}/move`, {
    method: 'POST',
    data: { department: 'Quality' },
  });
  expect(move.status).toBe(403);

  const ownMove = await api(page, `/api/workorders/${data.raleigh.workOrderId}/move`, {
    method: 'POST',
    data: { department: 'Dispatch' },
  });
  expect(ownMove.status).toBe(403);

  await page.goto('/scan');
  await page.getByRole('combobox', { name: /^Location\b/ }).click();
  await page.getByRole('option', { name: 'Dispatch', exact: true }).click();
  await page.getByRole('textbox', { name: /^Barcode\b/ }).fill(c.HICKORY_EXTERNAL_ID);
  await page.getByRole('button', { name: 'Record scan' }).click();
  await expect(page.getByRole('alert')).toContainText('Work order not found');

  const db = openDb();
  try {
    const row = await db.get(`SELECT department FROM work_orders WHERE external_id = ?`, [c.HICKORY_EXTERNAL_ID]);
    expect(row.department).toBe('Archive File');
  } finally {
    await db.close();
  }
});

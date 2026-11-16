const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { nextWeekday } = require('../dates');
const { c, login, api, runtime, chooseSelect, labelled } = require('../helpers');

const shotDir = process.env.E2E_SHOT_DIR || '/opt/cursor/artifacts';

async function shot(page, name) {
  if (!fs.existsSync(shotDir)) return;
  await page.screenshot({ path: path.join(shotDir, name) });
}

async function chooseMulti(page, label, options) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: new RegExp(`^${label}\\b`) }).click();
  for (const option of options) {
    const choice = page.getByRole('option', { name: option, exact: true });
    await expect(choice).toBeVisible();
    await choice.click();
  }
  await page.keyboard.press('Escape');
}

function serviceByName(body, name) {
  return body.services.find((service) => service.name === name);
}

test('new Signs and Small Format lines save the catalog choices', async ({ page }) => {
  await login(page, c.MANAGER_RALEIGH);
  const options = await api(page, '/api/orders/options');
  expect(options.status).toBe(200);
  expect(options.body.payment_methods).toContain('Mastercard');
  expect(options.body.payment_methods).not.toContain('Master Card');
  const signs = serviceByName(options.body, 'Signs & Graphics');
  const small = serviceByName(options.body, 'Small Format');
  const signsFields = Object.fromEntries(signs.fields.map((field) => [field.key, field]));
  const smallFields = Object.fromEntries(small.fields.map((field) => [field.key, field]));
  expect(signsFields.equipment).toBeUndefined();
  expect(signsFields.product_type.options).toEqual(expect.arrayContaining(['Fence Screen', 'Construction Sign']));
  expect(signsFields.finishing.type).toBe('multiselect');
  expect(signsFields.finishing.options).toEqual(expect.arrayContaining(['Hems', 'Pole Pockets', 'Wind Slits', 'Install', 'Stakes']));
  expect(smallFields.media.options).toContain('80# Uncoated Text');
  expect(smallFields.media.options.some((name) => /60#/i.test(name) && /gloss/i.test(name))).toBe(false);
  expect(smallFields.product.options).toContain('Mailing Services');
  expect(smallFields.finishing.options).toContain('Bulk Mailing/EDDM');
  expect(options.body.services.some((service) => service.name === 'Mailing')).toBe(false);

  await page.goto('/order');
  await expect(page.getByRole('heading', { name: 'Create Order', exact: true, level: 1 })).toBeVisible();
  await chooseSelect(page, 'Customer', c.CUSTOMER_RALEIGH.displayName);
  await labelled(page, 'combobox', 'Payment Method').click();
  await expect(page.getByRole('option', { name: 'Mastercard', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Master Card', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Mastercard', exact: true }).click();
  const project = `Catalog signs ${Date.now()}`;
  await labelled(page, 'textbox', 'Project Name').fill(project);

  await page.getByRole('checkbox', { name: 'Signs & Graphics', exact: true }).click();
  await page.getByTestId(`add-line-${signs.id}`).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Equipment', { exact: true })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: /^Product Type\b/ }).click();
  await expect(page.getByRole('option', { name: 'Fence Screen', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Construction Sign', exact: true })).toBeVisible();
  await shot(page, 'signs-graphics-line-form.png');
  await page.getByRole('option', { name: 'Fence Screen', exact: true }).click();
  await chooseSelect(page, 'Material', 'Banner');
  await dialog.getByRole('textbox', { name: /^Size\b/ }).fill('6x3');
  await dialog.getByRole('spinbutton', { name: /^Qty\b/ }).fill('2');
  await chooseSelect(page, 'Ink', 'Outdoor');
  await chooseSelect(page, 'Mount', 'No');
  await chooseSelect(page, 'Laminate', 'Matte');
  await chooseMulti(page, 'Finishing', ['Hems', 'Pole Pockets', 'Wind Slits']);
  await shot(page, 'signs-graphics-finishing.png');
  await dialog.getByRole('button', { name: 'Save line' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Hems, Pole Pockets, Wind Slits').first()).toBeVisible();

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editDialog = page.getByRole('dialog');
  await editDialog.getByRole('combobox', { name: /^Finishing\b/ }).click();
  const noneOption = page.getByRole('option', { name: 'None', exact: true });
  const hemsOption = page.getByRole('option', { name: 'Hems', exact: true });
  await noneOption.click();
  await expect(noneOption).toHaveAttribute('aria-selected', 'true');
  await expect(hemsOption).toHaveAttribute('aria-selected', 'false');
  await hemsOption.click();
  await expect(noneOption).toHaveAttribute('aria-selected', 'false');
  await expect(hemsOption).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('option', { name: 'Pole Pockets', exact: true }).click();
  await page.getByRole('option', { name: 'Wind Slits', exact: true }).click();
  await page.getByRole('option', { name: 'Stakes', exact: true }).click();
  await page.keyboard.press('Escape');
  await editDialog.getByRole('button', { name: 'Save line' }).click();
  await expect(page.getByText('Hems, Pole Pockets, Wind Slits, Stakes').first()).toBeVisible();
  await expect(page.getByText(/None, Hems/)).toHaveCount(0);

  await page.getByRole('checkbox', { name: 'Small Format', exact: true }).click();
  await page.getByTestId(`add-line-${small.id}`).click();
  const smallDialog = page.getByRole('dialog');
  await chooseSelect(page, 'Product', 'Mailing Services');
  await smallDialog.getByRole('textbox', { name: /^Originals\b/ }).fill('1');
  await smallDialog.getByRole('textbox', { name: /^Copies\b/ }).fill('25');
  await chooseSelect(page, 'Finished Size', '8.5x11');
  await chooseSelect(page, 'Process', 'Color');
  await chooseSelect(page, 'Sides/Color', '4/0 full color one side');
  await smallDialog.getByRole('combobox', { name: /^Paper Stock\b/ }).click();
  const paperChoices = page.getByRole('option');
  const uncoated = page.getByRole('option', { name: '80# Uncoated Text', exact: true });
  await expect(uncoated).toBeVisible();
  await uncoated.scrollIntoViewIfNeeded();
  const paperNames = await paperChoices.allTextContents();
  expect(paperNames.some((name) => /60#/i.test(name) && /gloss/i.test(name))).toBe(false);
  await shot(page, 'small-format-line-form.png');
  await page.getByRole('option', { name: '80# Uncoated Text', exact: true }).click();
  await chooseSelect(page, 'Binding', 'None');
  await smallDialog.getByRole('button', { name: 'Save line' }).click();
  await expect(page.getByText('80# Uncoated Text').first()).toBeVisible();

  await chooseSelect(page, 'Originals Source', 'Hardcopy or digital media provided');
  await page.locator('#order-due-date').fill(nextWeekday());
  await chooseSelect(page, 'Due Time', '10:00 AM');
  await page.getByTestId('submit-order').click();
  await expect(page.getByTestId('order-number')).toBeVisible();
  await page.getByRole('button', { name: 'View Submitted Order' }).click();
  await expect(page.getByText(project).first()).toBeVisible();
  await expect(page.getByText(/Finishing: Hems, Pole Pockets, Wind Slits, Stakes/)).toBeVisible();
  await expect(page.getByText(/Paper Stock: 80# Uncoated Text/)).toBeVisible();
  await expect(page.getByText(/Equipment:/)).toHaveCount(0);

  const orderId = new URL(page.url()).pathname.split('/').pop();
  const loaded = await api(page, `/api/orders/${orderId}`);
  expect(loaded.status).toBe(200);
  expect(loaded.body.order.payment_method).toBe('Mastercard');
  const signsLine = loaded.body.order.line_items.find((item) => item.service_name === 'Signs & Graphics');
  expect(signsLine.field_values.finishing).toEqual(['Hems', 'Pole Pockets', 'Wind Slits', 'Stakes']);
  expect(signsLine.field_values.product_type).toBe('Fence Screen');
  expect(signsLine.field_values.equipment).toBeUndefined();
  const smallLine = loaded.body.order.line_items.find((item) => item.service_name === 'Small Format');
  expect(smallLine.field_values.media).toBe('80# Uncoated Text');
  expect(smallLine.field_values.product).toBe('Mailing Services');
});

test('a legacy Signs order still renders and survives an edit', async ({ page }) => {
  const data = runtime();
  await login(page, c.MANAGER_RALEIGH);
  await page.goto(`/orders/${data.legacySigns.orderId}`);
  await expect(page.getByText(c.LEGACY_SIGNS_PROJECT).first()).toBeVisible();
  await expect(page.getByText(/Equipment: Flatbed/)).toBeVisible();
  await expect(page.getByText(/Mount: Coroplast/)).toBeVisible();
  await expect(page.getByText(/Laminate: Matte/)).toBeVisible();
  await expect(page.getByText(/Finishing: Grommets/)).toBeVisible();
  await expect(page.getByText('Mastercard').first()).toBeVisible();
  const legacyLine = page.getByText(/Equipment: Flatbed/);
  await legacyLine.scrollIntoViewIfNeeded();
  await shot(page, 'legacy-signs-order-detail.png');
  const detailText = await page.locator('body').innerText();
  expect(detailText).not.toMatch(/\bCorplast\b/);
  expect(detailText).not.toMatch(/\bMatt\b/);
  expect(detailText).not.toMatch(/Master Card/);

  const before = await api(page, `/api/orders/${data.legacySigns.orderId}`);
  expect(before.status).toBe(200);
  expect(before.body.order.payment_method).toBe('Master Card');
  expect(before.body.order.payment_method_label).toBe('Mastercard');
  const line = before.body.order.line_items[0];
  expect(line.field_values.mount).toBe('Corplast');
  expect(line.field_values.laminate).toBe('Matt');
  expect(line.field_values.finishing).toBe('Grommets');
  expect(line.field_values.equipment).toBe('Flatbed');
  expect(line.fields.find((field) => field.key === 'equipment').display).toBe('Flatbed');
  expect(line.fields.find((field) => field.key === 'mount').display).toBe('Coroplast');
  expect(line.fields.find((field) => field.key === 'laminate').display).toBe('Matte');
  expect(line.fields.find((field) => field.key === 'finishing').display).toBe('Grommets');

  const printed = await api(page, `/api/orders/${data.legacySigns.orderId}/print`);
  expect(printed.status).toBe(200);
  const printLine = printed.body.work_orders[0].line_items[0];
  expect(printLine.fields.find((field) => field.key === 'equipment').display).toBe('Flatbed');
  expect(printLine.fields.find((field) => field.key === 'finishing').display).toBe('Grommets');

  await page.goto(`/work-orders/${data.legacySigns.workOrderId}/edit`);
  const edited = 'Legacy fence banner — checked after the field change';
  await page.getByLabel('Description').fill(edited);
  await page.getByRole('button', { name: 'Update Work Order' }).click();
  await expect(page.getByText(edited).first()).toBeVisible();

  await page.goto(`/orders/${data.legacySigns.orderId}`);
  await expect(page.getByText(/Equipment: Flatbed/)).toBeVisible();
  await expect(page.getByText(/Mount: Coroplast/)).toBeVisible();
  await expect(page.getByText(/Laminate: Matte/)).toBeVisible();
  await expect(page.getByText(/Finishing: Grommets/)).toBeVisible();
  await expect(page.getByText('Mastercard').first()).toBeVisible();

  const after = await api(page, `/api/orders/${data.legacySigns.orderId}`);
  expect(after.body.order.line_items[0].field_values).toEqual(line.field_values);
  expect(after.body.order.payment_method).toBe('Master Card');
  const workOrder = await api(page, `/api/workorders/${data.legacySigns.workOrderId}`);
  expect(workOrder.status).toBe(200);
  expect(workOrder.body.description).toBe(edited);
  const spec = JSON.stringify(workOrder.body.specification_lines || []);
  expect(spec).toContain('Flatbed');
  expect(spec).toContain('Grommets');
  expect(spec).toContain('Coroplast');
});

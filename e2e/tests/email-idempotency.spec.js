const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { c, login, api, runtime, openDb, fillStaffOrder, checkMailbox } = require('../helpers');

const ORDER_SUBJECT = 'E2E mailbox order for the shop';
const AUTO_SUBJECT = 'Automatic reply: out of office';
const REPLY_SUBJECT = 'Re: your Launchpad notice';
const RACE_SUBJECT = 'E2E mailbox order raced twice';

function message({ id, subject, from, headers = [], body }) {
  return {
    id,
    subject,
    receivedDateTime: new Date().toISOString(),
    hasAttachments: false,
    from: { emailAddress: { name: from.name, address: from.address } },
    body: { contentType: 'text', content: body },
    internetMessageHeaders: headers,
  };
}

async function pushMessages(request, messages) {
  const data = runtime();
  const response = await request.post(`${data.graphBase}/__e2e/messages`, { data: messages });
  expect(response.ok()).toBeTruthy();
}

async function ordersForEmail(graphId) {
  const db = openDb();
  try {
    const email = await db.get(
      `SELECT id, status, ignore_reason, order_id FROM inbound_emails WHERE graph_message_id = ?`,
      [graphId]
    );
    const orders = email
      ? await db.all(`SELECT id, order_number FROM orders WHERE source_inbound_email_id = ?`, [email.id])
      : [];
    const workOrders = orders.length
      ? await db.all(
        `SELECT id FROM work_orders WHERE order_id IN (${orders.map(() => '?').join(', ')})`,
        orders.map((row) => row.id)
      )
      : [];
    return { email, orders, workOrders };
  } finally {
    await db.close();
  }
}

test('a fresh database leaves mailbox polling off and the poller imports nothing', async ({ request }) => {
  const root = path.join(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-poll-off-'));
  const dbFile = path.join(dir, 'launchpad.db');
  const init = spawnSync(process.execPath, [path.join(root, 'backend', 'init_db.js')], {
    cwd: path.join(root, 'backend'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_FILE: dbFile,
      INIT_ADMIN_PASSWORD: c.ADMIN.password,
    },
    encoding: 'utf8',
  });
  expect(init.status, `${init.stdout}\n${init.stderr}`).toBe(0);

  const sqlite3 = require(path.join(root, 'backend', 'node_modules', 'sqlite3')).verbose();
  const setting = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.get(
      `SELECT value FROM system_settings WHERE key = 'inbound_email_polling_enabled'`,
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
  expect(setting.value).toBe('0');

  const graph = runtime();
  await pushMessages(request, [
    message({
      id: 'e2e-poll-off',
      subject: 'Must not be imported while polling is off',
      from: { name: 'Pat Buyer', address: 'pat@customer-orders.example' },
      body: 'This message stays in the mailbox.',
    }),
  ]);

  const poll = spawnSync(process.execPath, ['-e', `
    process.env.DATABASE_FILE = ${JSON.stringify(dbFile)};
    process.env.NODE_ENV = 'test';
    process.env.M365_TENANT_ID = 'e2e-tenant';
    process.env.M365_CLIENT_ID = 'e2e-client';
    process.env.M365_CLIENT_SECRET = 'e2e-secret-not-real';
    process.env.M365_MAILBOX = ${JSON.stringify(c.MAILBOX)};
    process.env.M365_LOGIN_BASE_URL = ${JSON.stringify(graph.graphBase)};
    process.env.M365_GRAPH_BASE_URL = ${JSON.stringify(graph.graphBase)};
    const poller = require(${JSON.stringify(path.join(root, 'backend', 'inboundEmailPoller.js'))});
    poller.runScheduledPoll().then((result) => {
      process.stdout.write(JSON.stringify(result));
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `], { encoding: 'utf8' });
  expect(poll.status, `${poll.stdout}\n${poll.stderr}`).toBe(0);
  expect(JSON.parse(poll.stdout)).toEqual({ skipped: 'disabled' });

  const imported = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.get(
      `SELECT COUNT(*) AS count FROM inbound_emails WHERE graph_message_id = 'e2e-poll-off'`,
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row.count);
      }
    );
  });
  expect(imported).toBe(0);
});

test('the same inbound email is stored once', async ({ page, request }) => {
  await pushMessages(request, [
    message({
      id: 'e2e-order-once',
      subject: ORDER_SUBJECT,
      from: { name: 'Pat Buyer', address: 'pat@customer-orders.example' },
      body: 'Project: E2E archived drawings\nPlease print the archived set.',
    }),
  ]);

  await login(page, c.ADMIN);
  await page.goto('/email-orders');
  await expect(page.getByText('Scheduled polling is on.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled();
  await checkMailbox(page);
  await expect(page.getByRole('link', { name: ORDER_SUBJECT })).toHaveCount(1);
  await checkMailbox(page);
  await expect(page.getByRole('link', { name: ORDER_SUBJECT })).toHaveCount(1);

  const list = await api(page, '/api/inbound-emails?status=new');
  expect(list.status).toBe(200);
  const matches = (list.body.emails || []).filter((row) => row.subject === ORDER_SUBJECT);
  expect(matches).toHaveLength(1);

  const stored = await ordersForEmail('e2e-order-once');
  expect(stored.email).toBeTruthy();
  expect(stored.email.status).toBe('new');
  expect(stored.orders).toHaveLength(0);
});

test('replies and automatic replies are ignored and do not become orders', async ({ page, request }) => {
  await pushMessages(request, [
    message({
      id: 'e2e-auto',
      subject: AUTO_SUBJECT,
      from: { name: 'Mailer', address: 'mailer@customer-orders.example' },
      headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
      body: 'I am away from the office.',
    }),
    message({
      id: 'e2e-reply',
      subject: REPLY_SUBJECT,
      from: { name: 'Pat Buyer', address: 'pat@customer-orders.example' },
      headers: [{ name: 'In-Reply-To', value: c.OUTBOUND_MESSAGE_ID }],
      body: 'Thanks, we received the notice.',
    }),
    message({
      id: 'e2e-from-launchpad',
      subject: 'Copy of a Launchpad message',
      from: { name: 'Launchpad', address: c.SMTP_FROM },
      body: 'This was sent by Launchpad.',
    }),
  ]);

  await login(page, c.ADMIN);
  await page.goto('/email-orders');
  await checkMailbox(page);
  await page.getByRole('combobox', { name: /^Status\b/ }).click();
  await page.getByRole('option', { name: 'All', exact: true }).click();
  for (const subject of [AUTO_SUBJECT, REPLY_SUBJECT, 'Copy of a Launchpad message']) {
    const row = page.getByRole('row').filter({ hasText: subject });
    await expect(row).toContainText('ignored');
    await expect(row.getByRole('link', { name: /Order / })).toHaveCount(0);
  }

  const ignored = await api(page, '/api/inbound-emails?status=ignored');
  expect(ignored.status).toBe(200);
  const bySubject = Object.fromEntries((ignored.body.emails || []).map((row) => [row.subject, row]));
  expect(bySubject[AUTO_SUBJECT].order_id).toBeFalsy();
  expect(bySubject[REPLY_SUBJECT].order_id).toBeFalsy();

  for (const id of ['e2e-auto', 'e2e-reply', 'e2e-from-launchpad']) {
    const stored = await ordersForEmail(id);
    expect(stored.email.status).toBe('ignored');
    expect(stored.email.ignore_reason).toBeTruthy();
    expect(stored.email.order_id).toBeFalsy();
    expect(stored.orders).toHaveLength(0);
  }
});

test('converting an email twice, including a double submit, creates one order', async ({ page, request }) => {
  await pushMessages(request, [
    message({
      id: 'e2e-order-once',
      subject: ORDER_SUBJECT,
      from: { name: 'Pat Buyer', address: 'pat@customer-orders.example' },
      body: 'Project: E2E archived drawings\nPlease print the archived set.',
    }),
  ]);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await login(page, c.ADMIN);
  await page.goto('/email-orders');
  await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled();
  await checkMailbox(page);
  await page.getByRole('link', { name: ORDER_SUBJECT }).click();
  await expect(page).toHaveURL(/\/email-orders\/\d+/);
  const rendered = await page.getByTestId('email-subject').waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  expect(rendered, `Email detail did not render. Page errors: ${pageErrors.join(' | ') || 'none'}`).toBe(true);
  await expect(page.getByTestId('email-subject')).toHaveText(ORDER_SUBJECT);

  await fillStaffOrder(page, {
    customerName: c.CUSTOMER_RALEIGH.displayName,
    projectName: 'E2E mailbox archived drawings',
    notes: 'Pull the archived drawings named in the email.',
    confirmInbound: true,
  });
  await expect(page.getByTestId('order-number')).toBeVisible();
  const orderNumber = (await page.getByTestId('order-number').innerText()).replace('Order #:', '').trim();

  await page.goto('/email-orders');
  await page.getByRole('combobox', { name: /^Status\b/ }).click();
  await page.getByRole('option', { name: 'Converted', exact: true }).click();
  const converted = page.getByRole('row').filter({ hasText: ORDER_SUBJECT });
  await expect(converted).toContainText('Converted');
  await converted.getByRole('link', { name: ORDER_SUBJECT }).click();
  await expect(page.getByRole('link', { name: `Order ${orderNumber}` })).toBeVisible();

  const first = await ordersForEmail('e2e-order-once');
  expect(first.orders).toHaveLength(1);
  expect(first.workOrders.length).toBeGreaterThan(0);
  const emailId = first.email.id;

  const again = await api(page, `/api/inbound-emails/${emailId}/convert`, {
    method: 'POST',
    data: { customer_id: runtime().users.customerRaleigh },
  });
  expect(again.status).toBe(409);

  const still = await ordersForEmail('e2e-order-once');
  expect(still.orders).toHaveLength(1);
  expect(still.workOrders).toHaveLength(first.workOrders.length);

  await pushMessages(request, [
    message({
      id: 'e2e-order-race',
      subject: RACE_SUBJECT,
      from: { name: 'Pat Buyer', address: 'pat@customer-orders.example' },
      body: 'Project: raced archived drawings',
    }),
  ]);
  await page.goto('/email-orders');
  await page.getByRole('combobox', { name: /^Status\b/ }).click();
  await page.getByRole('option', { name: 'New', exact: true }).click();
  await checkMailbox(page);
  await page.getByRole('link', { name: RACE_SUBJECT }).click();
  await expect(page).toHaveURL(/\/email-orders\/\d+/);

  const { labelled } = require('../helpers');
  await labelled(page, 'combobox', 'Customer').click();
  await page.getByRole('option', { name: c.CUSTOMER_RALEIGH.displayName, exact: true }).click();
  await page.locator('#confirm-customer').check();
  await page.locator('#confirm-recipient').check();
  await labelled(page, 'textbox', 'Project Name').fill('E2E raced archived drawings');
  await labelled(page, 'combobox', 'Payment Method').click();
  await page.getByRole('option', { name: 'Cash', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Archive File Request' }).click();
  await labelled(page, 'combobox', 'Originals Source').click();
  await page.getByRole('option', { name: 'Hardcopy or digital media provided', exact: true }).click();
  await labelled(page, 'textbox', 'Special instructions').fill('Pull the raced archived set.');
  const { nextWeekday } = require('../dates');
  await page.locator('#order-due-date').fill(nextWeekday());
  await labelled(page, 'combobox', 'Due Time').click();
  await page.getByRole('option', { name: '10:00 AM', exact: true }).click();

  await page.evaluate(() => {
    const form = document.getElementById('order-form');
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.getByTestId('order-number')).toBeVisible({ timeout: 20000 });

  const raced = await ordersForEmail('e2e-order-race');
  expect(raced.orders).toHaveLength(1);
  expect(raced.workOrders).toHaveLength(1);
  expect(raced.email.status).toBe('converted');
});

test('converting without the stored confirmations is refused', async ({ page, request }) => {
  const subject = 'E2E mailbox order unconfirmed';
  await pushMessages(request, [
    message({
      id: 'e2e-order-unconfirmed',
      subject,
      from: { name: 'Pat Buyer', address: 'pat@customer-orders.example' },
      body: 'Project: unconfirmed archived drawings',
    }),
  ]);
  await login(page, c.ADMIN);
  await page.goto('/email-orders');
  await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled();
  await checkMailbox(page);
  const listed = await api(page, '/api/inbound-emails?status=new');
  const email = (listed.body.emails || []).find((row) => row.subject === subject);
  expect(email).toBeTruthy();

  const data = runtime();
  const { nextWeekday } = require('../dates');
  const services = await api(page, '/api/orders/options');
  const archive = (services.body.services || []).find((row) => row.name === 'Archive File Request');
  expect(archive).toBeTruthy();
  const refused = await api(page, `/api/inbound-emails/${email.id}/convert`, {
    method: 'POST',
    data: {
      customer_id: data.users.customerRaleigh,
      company: c.CUSTOMER_RALEIGH.company,
      contact_name: c.CUSTOMER_RALEIGH.contact,
      phone: c.CUSTOMER_RALEIGH.phone,
      email: c.CUSTOMER_RALEIGH.email,
      project_name: 'Unconfirmed archived drawings',
      notes: 'These confirmations were not stored.',
      originals_source: 'Hardcopy or digital media provided',
      address_line1: c.CUSTOMER_RALEIGH.address1,
      city: c.CUSTOMER_RALEIGH.city,
      state: c.CUSTOMER_RALEIGH.state,
      zip: c.CUSTOMER_RALEIGH.zip,
      delivery_method: 'Will Call',
      due_date: nextWeekday(),
      due_time: '10:00',
      return_to: 'To Me',
      payment_method: 'Cash',
      service_ids: [archive.id],
      line_items: [],
      location_id: data.locations.raleigh,
    },
  });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/confirm/i);

  const stored = await ordersForEmail('e2e-order-unconfirmed');
  expect(stored.orders).toHaveLength(0);
  expect(stored.email.status).toBe('new');
});

test('two concurrent converts create one order and one set of work orders', async ({ page, request }) => {
  const subject = 'E2E mailbox order concurrent';
  await pushMessages(request, [
    message({
      id: 'e2e-order-concurrent',
      subject,
      from: { name: 'Pat Buyer', address: 'pat@customer-orders.example' },
      body: 'Project: concurrent archived drawings',
    }),
  ]);
  await login(page, c.ADMIN);
  await page.goto('/email-orders');
  await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled();
  await checkMailbox(page);
  const listed = await api(page, '/api/inbound-emails?status=new');
  const email = (listed.body.emails || []).find((row) => row.subject === subject);
  expect(email).toBeTruthy();

  const data = runtime();
  const customer = data.users.customerRaleigh;
  const confirmed = await api(page, `/api/inbound-emails/${email.id}/confirmations`, {
    method: 'POST',
    data: {
      customer_id: customer,
      recipient: c.CUSTOMER_RALEIGH.email,
    },
  });
  expect(confirmed.status).toBe(200);

  const { nextWeekday } = require('../dates');
  const payload = {
    customer_id: customer,
    company: c.CUSTOMER_RALEIGH.company,
    contact_name: c.CUSTOMER_RALEIGH.contact,
    phone: c.CUSTOMER_RALEIGH.phone,
    email: c.CUSTOMER_RALEIGH.email,
    project_name: 'Concurrent archived drawings',
    notes: 'Pull the concurrent archived set.',
    originals_source: 'Hardcopy or digital media provided',
    address_line1: c.CUSTOMER_RALEIGH.address1,
    city: c.CUSTOMER_RALEIGH.city,
    state: c.CUSTOMER_RALEIGH.state,
    zip: c.CUSTOMER_RALEIGH.zip,
    delivery_method: 'Will Call',
    due_date: nextWeekday(),
    due_time: '10:00',
    return_to: 'To Me',
    payment_method: 'Cash',
    service_ids: [],
    line_items: [],
    location_id: data.locations.raleigh,
  };
  const services = await api(page, '/api/orders/options');
  const archive = (services.body.services || []).find((row) => row.name === 'Archive File Request');
  expect(archive).toBeTruthy();
  payload.service_ids = [archive.id];

  const auth = await page.evaluate(() => ({
    token: localStorage.getItem('lp_token'),
    csrf: sessionStorage.getItem('lp_csrf'),
  }));
  const send = () => page.request.post(`/api/inbound-emails/${email.id}/convert`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'X-CSRF-Token': auth.csrf,
    },
    data: payload,
  });
  const [left, right] = await Promise.all([send(), send()]);
  const statuses = [left.status(), right.status()].sort();
  expect(statuses.filter((status) => status === 201)).toHaveLength(1);
  expect(statuses.filter((status) => status === 409 || status === 201)).toHaveLength(2);

  const stored = await ordersForEmail('e2e-order-concurrent');
  expect(stored.orders).toHaveLength(1);
  expect(stored.workOrders).toHaveLength(1);
  expect(stored.email.status).toBe('converted');
  expect(stored.orders[0].id).toBe(stored.email.order_id);

  const repeat = await send();
  expect(repeat.status()).toBe(409);
  const afterRepeat = await ordersForEmail('e2e-order-concurrent');
  expect(afterRepeat.orders).toHaveLength(1);
  expect(afterRepeat.workOrders).toHaveLength(1);
});

# Functional tests

Playwright drives the Launchpad UI and checks the API behind it. The tests assert text, status codes, and database rows. Screenshots and traces are written only when a test fails, and they are not the assertions.

## What the suite uses

`npm run test:e2e` from the repo root starts `e2e/start-server.js`, which:

1. Builds `frontend/` when `frontend/dist/index.html` is missing or older than `frontend/src`, and serves that build from the API.
2. Runs `backend/init_db.js` against `e2e/.runtime/launchpad.db`. That file is created for the run and deleted at the start of the next one. `database/launchpad.db` is not opened.
3. Adds the accounts, customers, orders, and work orders below.
4. Listens on `http://127.0.0.1:4173` with `NODE_ENV=test`.

Mail uses `MAIL_TRANSPORT=json`. Nodemailer keeps the message in memory. SMTP settings in this process point at `127.0.0.1` only so the JSON transport is selected; the suite does not open a connection. Twilio variables are unset, so a text is not sent. The orders mailbox is a local stand-in (`e2e/mock-graph.js`). It does not call Microsoft. The client id, secret, and mailbox address in that process are fixed test strings, not credentials.

`init_db.js` still inserts `inbound_email_polling_enabled` as `0`, and a later init does not change a saved value. The test process sets that key to `1` only in `e2e/.runtime/launchpad.db` after init returns. A normal database is unchanged.

## Setup

From the repo root, with Node 22:

```bash
cd backend && npm ci
cd ../frontend && npm ci
cd .. && npm ci
npx playwright install chromium
npm run test:e2e
```

The HTML report is `playwright-report/`. A failure also leaves a screenshot and a trace under `test-results/`.

GitHub Actions job `e2e` runs the same command on every pull request. A failed test fails the job. The report and the failure artifacts are uploaded.

## Accounts

Every password is a test fixture. None of these accounts exist outside `e2e/.runtime/`.

| Username | Role | Shop | Password |
| --- | --- | --- | --- |
| `admin` | admin | every shop | `E2e-admin-pass-1` |
| `manager.raleigh` | manager | Raleigh | `E2e-staff-pass-1` |
| `manager.hickory` | manager | Hickory | `E2e-staff-pass-1` |
| `manager.none` | manager | none (every shop) | `E2e-staff-pass-1` |
| `operator.raleigh` | operator | Raleigh | `E2e-staff-pass-1` |

Customers `customer.raleigh` and `customer.hickory` have mobile numbers `+19195550111` and `+19195550222`. Raleigh work order `WO-E2E-RDU` and Hickory work order `WO-E2E-HKY` belong to those shops. A third order sits at Raleigh for the Hickory customer and has an SMS notice to `+19195550333`.

## Tests

- Login: a wrong password stays on the sign-in page. Logout makes the old bearer token return 401. `POST /api/inbound-emails/sync` without `X-CSRF-Token` returns 403.
- Operator: the board and `GET /api/workorders` include `WO-E2E-RDU` and omit `WO-E2E-HKY`. A scan at Quality moves the Raleigh job. The Hickory job returns 404 from the page, the scan, and `GET /api/workorders/:id`. `POST /api/workorders/:id/move` is 403 for an operator, including their own job. The scan is how an operator moves a job.
- Manager: Raleigh manager creates an order in the form, reloads the order, edits the work order description, and reloads that description. Hickory manager gets 404 for the Raleigh order and cannot save it.
- Admin: admin opens Users, Locations, System Settings, and the other admin pages. A manager and an operator have no nav entry, land on the dashboard from those URLs, and get 403 from the admin APIs.
- Email orders: Check now twice on one Graph message stores one row. An automatic reply, a reply to a Launchpad `Message-ID`, and mail from `SMTP_FROM` are ignored and create no order. Converting once in the form, converting again, submitting the form twice, and two concurrent convert calls each leave one order and one work order for that `source_inbound_email_id`.
- Customer privacy: an operator's pages and `GET /api/customers/lookup` do not contain the mobile numbers, and `GET /api/customers` is 403. An admin, and the Raleigh manager for the Raleigh customer, do see `+19195550111`. A Hickory manager cannot open the Raleigh order.

## Customer privacy

These checks run against the shop scoping that is on master:

- a Raleigh manager sees the Raleigh customer's mobile and does not see the Hickory customer's mobile. Updating texting for the Hickory customer is HTTP 404
- a manager with no shop sees no mobiles
- order detail for an order at Raleigh whose customer is at Hickory omits the SMS recipient from an operator, the Raleigh manager, and the manager with no shop. The email recipient stays. An admin still sees the SMS recipient

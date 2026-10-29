// Throwaway credentials for the functional test database only.
// They are not production secrets and are never used against a real mailbox.

const PORT = 4173;

const PASSWORD = 'E2e-staff-pass-1';

module.exports = {
  PORT,
  BASE_URL: `http://127.0.0.1:${PORT}`,
  ADMIN: { username: 'admin', password: 'E2e-admin-pass-1' },
  MANAGER_RALEIGH: { username: 'manager.raleigh', password: PASSWORD },
  MANAGER_HICKORY: { username: 'manager.hickory', password: PASSWORD },
  MANAGER_NONE: { username: 'manager.none', password: PASSWORD },
  OPERATOR: { username: 'operator.raleigh', password: PASSWORD },
  CUSTOMER_RALEIGH: {
    username: 'customer.raleigh',
    displayName: 'Raleigh Fixture Co',
    company: 'Raleigh Fixture Co',
    contact: 'Riley Raleigh',
    phone: '919-555-0140',
    email: 'riley@raleigh-fixture.example',
    mobile: '+19195550111',
    address1: '10 Fixture Lane',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
  },
  CUSTOMER_HICKORY: {
    username: 'customer.hickory',
    displayName: 'Hickory Fixture Co',
    company: 'Hickory Fixture Co',
    contact: 'Harper Hickory',
    phone: '828-555-0141',
    email: 'harper@hickory-fixture.example',
    mobile: '+19195550222',
    address1: '20 Fixture Lane',
    city: 'Hickory',
    state: 'NC',
    zip: '28602',
  },
  // Distinct from either customer's stored mobile, so an order-detail SMS
  // recipient can be checked on its own.
  TRANSFER_SMS: '+19195550333',
  EMAIL_RECIPIENT: 'ready@e2e.launchpad.test',
  RALEIGH_EXTERNAL_ID: 'WO-E2E-RDU',
  HICKORY_EXTERNAL_ID: 'WO-E2E-HKY',
  RALEIGH_PROJECT: 'Raleigh fixture plates',
  HICKORY_PROJECT: 'Hickory fixture plates',
  TRANSFER_PROJECT: 'Transferred hickory job',
  RALEIGH_DESCRIPTION: 'Raleigh plates WO-E2E-RDU',
  HICKORY_DESCRIPTION: 'Hickory plates WO-E2E-HKY',
  OUTBOUND_MESSAGE_ID: '<e2e-notice@e2e.launchpad.test>',
  SMTP_FROM: 'orders@e2e.launchpad.test',
  MAILBOX: 'orders@e2e.launchpad.test',
};

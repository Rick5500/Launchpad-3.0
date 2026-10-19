const activityLog = require('./activityLog');
const { all, withTransaction } = require('./dbAsync');
const { httpError } = require('./httpError');

const IN_APP_EVENTS = [
  { event_key: 'delivery_overdue', label: 'Delivery overdue', description: 'A delivery is past its due time.' },
  { event_key: 'delivery_due_soon', label: 'Delivery due soon', description: 'A delivery is inside the due-soon window.' },
  { event_key: 'work_order_on_hold', label: 'Work order on hold', description: 'A work order was put on hold.' },
  { event_key: 'work_order_completed', label: 'Work order completed', description: 'A work order was completed.' },
  { event_key: 'work_order_rush', label: 'Rush work order', description: 'A rush-priority work order was created.' },
  { event_key: 'customer_registered', label: 'New customer account', description: 'A customer created their own account from the sign-in page.' },
];

const EMAIL_EVENTS = [
  { event_key: 'order_submitted', label: 'Order submitted', description: 'Email stub. No mail is sent.' },
  { event_key: 'work_order_status', label: 'Work order status', description: 'Email stub. No mail is sent.' },
  { event_key: 'delivery_reminder', label: 'Delivery reminder', description: 'Email stub. No mail is sent.' },
];

const IN_APP_KEYS = new Set(IN_APP_EVENTS.map((event) => event.event_key));
const EMAIL_KEYS = new Set(EMAIL_EVENTS.map((event) => event.event_key));

function presentRows(rows, catalog, channel) {
  const byKey = new Map((rows || []).filter((row) => row.channel === channel).map((row) => [row.event_key, row]));
  return catalog.map((event) => {
    const row = byKey.get(event.event_key);
    const enabled = row ? row.enabled !== 0 : channel === 'in_app';
    return {
      event_key: event.event_key,
      label: event.label,
      description: event.description,
      channel,
      enabled: channel === 'email' ? false : enabled,
      locked: channel === 'email',
    };
  });
}

async function getSettings() {
  const rows = await all(
    `SELECT event_key, enabled, channel FROM notification_settings ORDER BY id ASC`
  );
  return {
    in_app: presentRows(rows, IN_APP_EVENTS, 'in_app'),
    email: presentRows(rows, EMAIL_EVENTS, 'email'),
    email_status: 'disabled',
    email_label: 'Email delivery is off. No mail is sent.',
  };
}

function parseEnabled(value, key) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  throw httpError(400, `${key} must be true or false`);
}

async function updateSettings(actorId, body) {
  const source = body || {};
  const events = source.events;
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    throw httpError(400, 'events must be an object of event keys');
  }
  const keys = Object.keys(events);
  if (!keys.length) throw httpError(400, 'No notification settings to update');
  const changes = [];
  for (const key of keys) {
    if (EMAIL_KEYS.has(key)) {
      const enabled = parseEnabled(events[key], key);
      if (enabled === 1) throw httpError(400, 'Email notifications stay off. No mail is sent.');
      continue;
    }
    if (!IN_APP_KEYS.has(key)) throw httpError(400, `Unknown notification event: ${key}`);
    changes.push([key, parseEnabled(events[key], key)]);
  }
  if (!changes.length) {
    return getSettings();
  }
  await withTransaction(async (tx) => {
    for (const [key, enabled] of changes) {
      await tx.run(
        `INSERT INTO notification_settings (event_key, enabled, channel, updated_at)
         VALUES (?,?, 'in_app', datetime('now'))
         ON CONFLICT(event_key) DO UPDATE SET
           enabled = excluded.enabled,
           channel = 'in_app',
           updated_at = datetime('now')`,
        [key, enabled]
      );
    }
    await activityLog.recordOn(tx, actorId, 'notification_settings.updated', 'notification_settings', null, {
      events: Object.fromEntries(changes.map(([key, enabled]) => [key, enabled === 1])),
      message: `Updated notification settings`,
    });
  });
  return getSettings();
}

module.exports = {
  IN_APP_EVENTS,
  EMAIL_EVENTS,
  getSettings,
  updateSettings,
};

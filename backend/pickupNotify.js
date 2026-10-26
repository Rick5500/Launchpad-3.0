// Email and SMS when an order first becomes Ready for Pickup.
// A send failure is recorded and never thrown to the status update.

const { get, run } = require('./dbAsync');
const mailer = require('./mailer');
const sms = require('./sms');
const { loadLetterhead, letterheadFromMap } = require('./shopProfile');

function customerEmail(row) {
  const candidates = [row && row.email, row && row.account_email];
  for (const candidate of candidates) {
    const parsed = mailer.parseAddressList(candidate, { max: 1, field: 'email' });
    if (!parsed.error && parsed.value && parsed.value.length === 1) return parsed.value[0];
  }
  return null;
}

async function stamp(orderId, generation, fields) {
  const assignments = [];
  const params = [];
  for (const [column, value] of fields) {
    assignments.push(`${column} = ?`);
    params.push(value);
  }
  if (!assignments.length) return;
  params.push(orderId, generation);
  await run(
    `UPDATE orders SET ${assignments.join(', ')}
     WHERE id = ? AND pickup_notified_generation = ?`,
    params
  );
}

async function deliver(orderId, generation) {
  const result = {
    skipped: false,
    email: { status: 'skipped', sent_at: null },
    sms: { status: 'skipped', sent_at: null },
  };
  try {
    const row = await get(
      `SELECT o.id, o.order_number, o.email, o.status,
              u.email AS account_email, u.mobile_phone, u.sms_opt_in,
              loc.name AS location_name, loc.address AS location_address, loc.phone AS location_phone
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN locations loc ON loc.id = o.location_id
       WHERE o.id = ?`,
      [orderId]
    );
    if (!row) return result;

    let letterhead;
    try {
      letterhead = await loadLetterhead();
    } catch (err) {
      letterhead = letterheadFromMap({});
    }
    const link = mailer.orderPageLink(orderId);
    const rendered = mailer.renderPickupReadyEmail({
      letterhead,
      orderNumber: row.order_number,
      locationName: row.location_name,
      locationAddress: row.location_address,
      locationPhone: row.location_phone,
      link,
    });

    const to = customerEmail(row);
    if (!to) {
      result.email.status = 'skipped';
      await stamp(orderId, generation, [['pickup_email_status', 'skipped']]);
    } else {
      try {
        const sent = await mailer.deliver({
          to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
        const status = sent && sent.status ? sent.status : 'failed';
        result.email.status = status;
        result.email.to = to;
        if (process.env.NODE_ENV === 'test' && sent && sent.captured) {
          result.email.preview = mailer.previewFrom(sent.captured);
        }
        if (status === 'sent') {
          await stamp(orderId, generation, [
            ['pickup_email_sent_at', new Date().toISOString().slice(0, 19).replace('T', ' ')],
            ['pickup_email_status', 'sent'],
          ]);
        } else {
          await stamp(orderId, generation, [['pickup_email_status', status]]);
        }
      } catch (err) {
        console.error('PICKUP EMAIL ERROR:', err && err.code ? err.code : 'failed');
        result.email.status = 'failed';
        await stamp(orderId, generation, [['pickup_email_status', 'failed']]);
      }
    }

    const optedIn = Number(row.sms_opt_in) === 1;
    const mobile = sms.normalizeE164(row.mobile_phone);
    if (!optedIn) {
      result.sms.status = 'skipped';
      await stamp(orderId, generation, [['pickup_sms_status', 'skipped']]);
    } else if (!mobile) {
      result.sms.status = 'invalid';
      await stamp(orderId, generation, [['pickup_sms_status', 'invalid']]);
    } else {
      const body = sms.pickupSmsBody({
        orderNumber: row.order_number,
        locationName: row.location_name,
        locationAddress: row.location_address,
        locationPhone: row.location_phone,
      });
      const sent = await sms.sendSms({ to: mobile, body });
      result.sms.status = sent.status;
      result.sms.to = sent.to || mobile;
      if (sent.status === 'sent' || sent.status === 'dry_run') {
        await stamp(orderId, generation, [
          ['pickup_sms_sent_at', new Date().toISOString().slice(0, 19).replace('T', ' ')],
          ['pickup_sms_status', sent.status],
        ]);
      } else {
        await stamp(orderId, generation, [['pickup_sms_status', sent.status || 'failed']]);
      }
    }

    const stamped = await get(
      `SELECT pickup_email_sent_at, pickup_sms_sent_at, pickup_email_status, pickup_sms_status
       FROM orders WHERE id = ?`,
      [orderId]
    );
    if (stamped) {
      result.email.sent_at = stamped.pickup_email_sent_at || null;
      result.email.status = stamped.pickup_email_status || result.email.status;
      result.sms.sent_at = stamped.pickup_sms_sent_at || null;
      result.sms.status = stamped.pickup_sms_status || result.sms.status;
    }
  } catch (err) {
    console.error('PICKUP NOTIFY ERROR:', err && err.message ? err.message : 'failed');
    if (!result.email.status) result.email.status = 'failed';
    if (!result.sms.status) result.sms.status = 'failed';
  }
  return result;
}

module.exports = {
  deliver,
};

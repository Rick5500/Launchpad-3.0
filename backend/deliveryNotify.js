// Email and SMS when every work order on an Accent Truck order has reached
// Quality or a later stage. Entry into Quality, Dispatch, Delivery, or
// Complete (by dept_key) runs the same once-per-order check, so a work order
// that skips Quality still notifies when it is the last one to arrive.
// A send failure is recorded and never thrown back to the scan or move.

const { get, run, withTransaction } = require('./dbAsync');
const mailer = require('./mailer');
const sms = require('./sms');
const customerNotices = require('./customerNotices');
const { methodKey } = require('./deliveryRules');
const { isReadyStageId, allWorkOrdersAtOrPastQuality } = require('./departmentStage');
const { loadLetterhead, letterheadFromMap } = require('./shopProfile');

function isAccentTruck(name) {
  return methodKey(name) === 'accent truck';
}

function customerEmail(row) {
  const candidates = [row && row.email, row && row.account_email];
  for (const candidate of candidates) {
    const parsed = mailer.parseAddressList(candidate, { max: 1, field: 'email' });
    if (!parsed.error && parsed.value && parsed.value.length === 1) return parsed.value[0];
  }
  return null;
}

function stampNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
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
     WHERE id = ? AND delivery_notified_generation = ?`,
    params
  );
}

async function claim(orderId) {
  return withTransaction(async (tx) => {
    const order = await tx.get(
      `SELECT id, delivery_method, delivery_notified_generation FROM orders WHERE id = ?`,
      [orderId]
    );
    if (!order) return { skipped: true, reason: 'missing' };
    if (!isAccentTruck(order.delivery_method)) return { skipped: true, reason: 'not_accent_truck' };
    if (order.delivery_notified_generation != null) return { skipped: true, reason: 'already_notified' };
    const workOrders = await tx.all(
      `SELECT id, department, assigned_department_id, awaiting_originals FROM work_orders WHERE order_id = ?`,
      [orderId]
    );
    const ready = await allWorkOrdersAtOrPastQuality(tx, workOrders);
    if (!ready) return { skipped: true, reason: 'work_orders_not_ready' };
    const updated = await tx.run(
      `UPDATE orders
       SET delivery_ready_generation = COALESCE(delivery_ready_generation, 0) + 1,
           delivery_notified_generation = COALESCE(delivery_ready_generation, 0) + 1,
           delivery_email_sent_at = NULL,
           delivery_sms_sent_at = NULL,
           delivery_email_status = NULL,
           delivery_sms_status = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND delivery_notified_generation IS NULL`,
      [orderId]
    );
    if (!updated.changes) return { skipped: true, reason: 'already_notified' };
    const row = await tx.get(`SELECT delivery_ready_generation FROM orders WHERE id = ?`, [orderId]);
    return { generation: row ? row.delivery_ready_generation : 1 };
  });
}

async function deliver(orderId, generation) {
  const result = {
    skipped: false,
    email: { status: 'skipped', sent_at: null },
    sms: { status: 'skipped', sent_at: null },
  };
  try {
    const row = await get(
      `SELECT o.id, o.order_number, o.email, o.delivery_method, o.ship_to, o.due_date, o.due_time,
              u.email AS account_email, u.mobile_phone, u.sms_opt_in
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
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
    const rendered = mailer.renderReadyForDeliveryEmail({
      letterhead,
      orderNumber: row.order_number,
      dueDate: row.due_date,
      dueTime: row.due_time,
      deliveryMethod: row.delivery_method,
      shipTo: row.ship_to,
      link: mailer.orderPageLink(orderId),
    });

    const to = customerEmail(row);
    if (!to) {
      result.email.status = 'skipped';
      await stamp(orderId, generation, [['delivery_email_status', 'skipped']]);
    } else {
      try {
        const sent = await mailer.deliver({
          to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          noticeType: 'ready_for_delivery',
        });
        const status = sent && sent.status ? sent.status : 'failed';
        result.email.status = status;
        result.email.to = to;
        if (process.env.NODE_ENV === 'test' && sent && sent.captured) {
          result.email.preview = mailer.previewFrom(sent.captured);
        }
        if (status === 'sent') {
          await stamp(orderId, generation, [
            ['delivery_email_sent_at', stampNow()],
            ['delivery_email_status', 'sent'],
          ]);
        } else {
          await stamp(orderId, generation, [['delivery_email_status', status]]);
        }
      } catch (err) {
        console.error('DELIVERY EMAIL ERROR:', err && err.code ? err.code : 'failed');
        result.email.status = 'failed';
        await stamp(orderId, generation, [['delivery_email_status', 'failed']]);
      }
    }

    const optedIn = Number(row.sms_opt_in) === 1;
    const mobile = sms.normalizeE164(row.mobile_phone);
    if (!optedIn) {
      result.sms.status = 'skipped';
      await stamp(orderId, generation, [['delivery_sms_status', 'skipped']]);
    } else if (!mobile) {
      result.sms.status = 'invalid';
      await stamp(orderId, generation, [['delivery_sms_status', 'invalid']]);
    } else {
      const body = sms.deliverySmsBody({ orderNumber: row.order_number });
      const sent = await sms.sendSms({ to: mobile, body });
      result.sms.status = sent.status;
      result.sms.to = sent.to || mobile;
      if (sent.status === 'sent' || sent.status === 'dry_run') {
        await stamp(orderId, generation, [
          ['delivery_sms_sent_at', stampNow()],
          ['delivery_sms_status', sent.status],
        ]);
      } else {
        await stamp(orderId, generation, [['delivery_sms_status', sent.status || 'failed']]);
      }
    }

    await customerNotices.recordOrderNotice({
      orderId,
      channel: 'email',
      noticeType: 'ready_for_delivery',
      recipient: result.email.to || null,
      result: result.email.status,
    });
    await customerNotices.recordOrderNotice({
      orderId,
      channel: 'sms',
      noticeType: 'ready_for_delivery',
      recipient: result.sms.to || null,
      result: result.sms.status,
    });

    const stamped = await get(
      `SELECT delivery_email_sent_at, delivery_sms_sent_at, delivery_email_status, delivery_sms_status
       FROM orders WHERE id = ?`,
      [orderId]
    );
    if (stamped) {
      result.email.sent_at = stamped.delivery_email_sent_at || null;
      result.email.status = stamped.delivery_email_status || result.email.status;
      result.sms.sent_at = stamped.delivery_sms_sent_at || null;
      result.sms.status = stamped.delivery_sms_status || result.sms.status;
    }
  } catch (err) {
    console.error('DELIVERY NOTIFY ERROR:', err && err.message ? err.message : 'failed');
    if (!result.email.status) result.email.status = 'failed';
    if (!result.sms.status) result.sms.status = 'failed';
  }
  return result;
}

// Called after the department change has committed. The destination is
// matched by id and dept_key, not by the label on the scan or move.
async function afterReadyStageEntry({ orderId, departmentId }) {
  try {
    if (!orderId) return { skipped: true, reason: 'no_order' };
    const readyStage = await isReadyStageId({ get }, departmentId);
    if (!readyStage) return { skipped: true, reason: 'not_ready_stage' };
    const claimed = await claim(orderId);
    if (!claimed || claimed.skipped) return claimed || { skipped: true, reason: 'skipped' };
    return deliver(orderId, claimed.generation);
  } catch (err) {
    console.error('DELIVERY NOTIFY ERROR:', err && err.message ? err.message : 'failed');
    return { skipped: true, reason: 'failed', email: { status: 'failed' }, sms: { status: 'failed' } };
  }
}

module.exports = {
  isAccentTruck,
  afterReadyStageEntry,
  afterQualityEntry: afterReadyStageEntry,
  deliver,
  claim,
};

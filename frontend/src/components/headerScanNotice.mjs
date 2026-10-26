// Pending scan toasts. The one on screen is not put back in line when a
// more severe result replaces it. Errors and warnings stay queued, capped so
// a burst cannot trail the scanner. Successes collapse to the latest one.
// A toast alone stays up for 4s. When others are waiting it yields after 1.5s.

export const NOTICE_SEVERE_CAP = 5;
export const NOTICE_ALONE_MS = 4000;
export const NOTICE_QUEUED_MS = 1500;
const SEVERITY_RANK = { error: 3, warning: 2, success: 1, info: 0 };

export function severityRank(severity) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity) ? SEVERITY_RANK[severity] : 0;
}

function isSuccessNotice(severity) {
  return severityRank(severity) <= severityRank('success');
}

function normalizeQueue(queue) {
  let latestSuccess = null;
  const severe = [];
  for (const item of queue) {
    if (isSuccessNotice(item.severity)) latestSuccess = item;
    else severe.push(item);
  }
  const keptSevere = severe.length > NOTICE_SEVERE_CAP
    ? severe.slice(severe.length - NOTICE_SEVERE_CAP)
    : severe;
  return latestSuccess ? [...keptSevere, latestSuccess] : keptSevere;
}

export function noticeDuration(notice) {
  const waiting = Boolean(notice && notice.queue && notice.queue.length);
  return waiting ? NOTICE_QUEUED_MS : NOTICE_ALONE_MS;
}

export function noticeDelay(notice, now = Date.now()) {
  if (!notice) return 0;
  const started = Number.isFinite(notice.shownAt) ? notice.shownAt : now;
  return Math.max(0, started + noticeDuration(notice) - now);
}

export function reduceNotice(current, incoming, now = Date.now()) {
  const item = {
    id: incoming.id,
    severity: incoming.severity,
    message: incoming.message,
    orderId: incoming.orderId || null,
    orderNumber: incoming.orderNumber || '',
    orderStatus: incoming.orderStatus || '',
  };
  if (!current) return { ...item, shownAt: now, queue: [] };
  if (severityRank(incoming.severity) > severityRank(current.severity)) {
    return { ...item, shownAt: now, queue: normalizeQueue(current.queue || []) };
  }
  return { ...current, queue: normalizeQueue([...(current.queue || []), item]) };
}

export function advanceNotice(current, id, now = Date.now()) {
  if (!current || current.id !== id) return current;
  const queue = current.queue || [];
  if (!queue.length) return null;
  const [next, ...rest] = queue;
  return { ...next, shownAt: now, queue: rest };
}

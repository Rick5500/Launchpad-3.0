// Pending scan toasts. The one on screen keeps its full time. Errors and
// warnings stay queued, capped so a burst cannot trail the scanner by a
// minute. Successes collapse to the latest one.

export const NOTICE_SEVERE_CAP = 5;
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

export function reduceNotice(current, incoming) {
  if (!current) return { ...incoming, queue: [] };
  if (severityRank(incoming.severity) > severityRank(current.severity)) {
    const displaced = { id: current.id, severity: current.severity, message: current.message };
    return { ...incoming, queue: normalizeQueue([displaced, ...(current.queue || [])]) };
  }
  return { ...current, queue: normalizeQueue([...(current.queue || []), incoming]) };
}

export function advanceNotice(current, id) {
  if (!current || current.id !== id) return current;
  const queue = current.queue || [];
  if (!queue.length) return null;
  const [next, ...rest] = queue;
  return { ...next, queue: rest };
}

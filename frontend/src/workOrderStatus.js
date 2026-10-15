export function canonicalWorkOrderStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (value === 'complete') return 'completed';
  return value;
}

export function isFinishedWorkOrderStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  return value === 'completed' || value === 'complete';
}

export function isActiveWorkOrderStatus(status) {
  const value = canonicalWorkOrderStatus(status);
  return value === 'open' || value === 'in-progress';
}

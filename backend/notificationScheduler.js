const { checkDeliveryNotifications } = require('./notifications');

const DEFAULT_INTERVAL_SECONDS = 60;
let timer = null;

function intervalSeconds() {
  const parsed = Number(process.env.NOTIFICATION_CHECK_INTERVAL_SECONDS);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_INTERVAL_SECONDS;
  return parsed;
}

function runCheck() {
  checkDeliveryNotifications((err) => {
    if (err) console.error('NOTIFICATION CHECK ERROR:', err);
  });
}

function start() {
  if (timer) return timer;
  runCheck();
  timer = setInterval(runCheck, intervalSeconds() * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  start,
};

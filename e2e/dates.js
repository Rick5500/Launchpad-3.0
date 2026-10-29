function nextWeekday(timeZone = 'America/New_York') {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  for (let offset = 1; offset <= 7; offset += 1) {
    const when = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
    const day = weekday.format(when);
    if (day !== 'Sat' && day !== 'Sun') return iso.format(when);
  }
  throw new Error('Could not find a weekday');
}

module.exports = { nextWeekday };

/**
 * Business hours utility.
 * Uses Intl.DateTimeFormat to get current time in the configured timezone.
 */

function isBusinessHours() {
  const tz       = process.env.TIMEZONE            || 'Asia/Dubai';
  const start    = parseInt(process.env.BUSINESS_HOURS_START || '9',  10);
  const end      = parseInt(process.env.BUSINESS_HOURS_END   || '18', 10);
  const daysStr  = process.env.BUSINESS_DAYS || '1,2,3,4,5,6'; // Mon–Sat
  const days     = daysStr.split(',').map(Number);

  const now    = new Date();
  const parts  = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric', minute: 'numeric', weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour    = parseInt(get('hour'),   10);
  const weekday = get('weekday'); // 'Mon', 'Tue', …

  const weekdayNum = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? -1;

  return days.includes(weekdayNum) && hour >= start && hour < end;
}

module.exports = { isBusinessHours };

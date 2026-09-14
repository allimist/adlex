const DAY_MS = 86400000;

export function dayUTC(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function startOfDayUTC(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function parseDay(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isNaN(t) ? null : t;
}

export const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['all', 'All time'],
];

/**
 * Parse ?preset=&from=&to= into a half-open [from, to) range in epoch ms.
 * `to` day is inclusive in the UI, so we add one day.
 */
export function parseRange(query = {}, now = Date.now()) {
  const today = startOfDayUTC(now);
  let preset = query.preset || '';
  let from;
  let to;
  const qf = parseDay(query.from);
  const qt = parseDay(query.to);
  if (qf !== null || qt !== null) {
    preset = 'custom';
    from = qf ?? today - 30 * DAY_MS;
    to = (qt ?? today) + DAY_MS;
  } else {
    switch (preset) {
      case 'yesterday':
        from = today - DAY_MS;
        to = today;
        break;
      case '7d':
        from = today - 6 * DAY_MS;
        to = today + DAY_MS;
        break;
      case '30d':
        from = today - 29 * DAY_MS;
        to = today + DAY_MS;
        break;
      case 'all':
        from = 0;
        to = today + 10 * DAY_MS;
        break;
      default:
        preset = 'today';
        from = today;
        to = today + DAY_MS;
    }
  }
  return { preset, from, to, fromDay: dayUTC(from), toDay: dayUTC(to - DAY_MS) };
}

export function fmtDateTime(ms) {
  if (!ms) return '';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(d) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function parseISODate(value) {
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, days) {
  const n = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  n.setDate(n.getDate() + days);
  return n;
}

export function clampDate(year, monthIndex, day) {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(Math.max(1, day), last));
}

export function todayString() {
  return formatDate(new Date());
}

export function parseDateTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateTime(value);
  }
  const s = String(value ?? '').trim().replace(/\//g, '-');
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const ms = Date.UTC(1899, 11, 30) + Number(s) * 86400000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4] || 0)}:${pad(m[5] || 0)}:${pad(m[6] || 0)}`;
  }
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (m) {
    return `${m[3]}-${pad(m[1])}-${pad(m[2])} ${pad(m[4] || 0)}:${pad(m[5] || 0)}:${pad(m[6] || 0)}`;
  }
  return null;
}

export function normalizeClientDate(value) {
  if (!value) return null;
  return parseDateTime(String(value).trim().replace('T', ' '));
}

function weekday(date) {
  return date.getDay() === 0 ? 7 : date.getDay();
}

export function firstOccurrence(rule) {
  const start = rule.startDate;
  if (rule.frequency === 'weekly') {
    const d = parseISODate(start);
    const set = new Set(rule.weekdays?.length ? rule.weekdays : [1]);
    for (let i = 0; i < 7; i += 1) {
      const n = addDays(d, i);
      if (set.has(weekday(n))) return formatDate(n);
    }
  }
  if (rule.frequency === 'monthly') {
    const d = parseISODate(start);
    let occ = formatDate(clampDate(d.getFullYear(), d.getMonth(), rule.monthDay || 1));
    if (occ < start) {
      occ = formatDate(clampDate(d.getFullYear(), d.getMonth() + 1, rule.monthDay || 1));
    }
    return occ;
  }
  if (rule.frequency === 'yearly') {
    const d = parseISODate(start);
    const month = (rule.yearMonth || 1) - 1;
    const day = rule.yearDay || 1;
    let occ = formatDate(clampDate(d.getFullYear(), month, day));
    if (occ < start) occ = formatDate(clampDate(d.getFullYear() + 1, month, day));
    return occ;
  }
  return start;
}

export function advance(rule, date) {
  const d = parseISODate(date);
  if (rule.frequency === 'daily') return formatDate(addDays(d, 1));
  if (rule.frequency === 'interval') {
    return formatDate(addDays(d, Math.max(1, Number(rule.intervalDays) || 1)));
  }
  if (rule.frequency === 'weekly') {
    const set = new Set(rule.weekdays?.length ? rule.weekdays : [1]);
    for (let i = 1; i <= 7; i += 1) {
      const n = addDays(d, i);
      if (set.has(weekday(n))) return formatDate(n);
    }
  }
  if (rule.frequency === 'monthly') {
    return formatDate(clampDate(d.getFullYear(), d.getMonth() + 1, rule.monthDay || d.getDate()));
  }
  if (rule.frequency === 'yearly') {
    return formatDate(clampDate(d.getFullYear() + 1, (rule.yearMonth || d.getMonth() + 1) - 1, rule.yearDay || d.getDate()));
  }
  return null;
}

export function monthBounds(year, month) {
  const start = `${year}-${pad(month)}-01`;
  const last = new Date(year, month, 0).getDate();
  const end = `${year}-${pad(month)}-${pad(last)}`;
  return { start, end };
}

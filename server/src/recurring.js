import { db } from './db.js';
import { ensurePersonalBook } from './books.js';
import { advance, firstOccurrence, todayString } from './dates.js';

function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    bookId: row.book_id ?? null,
    type: row.type,
    amountCents: row.amount_cents,
    accountId: row.account_id,
    toAccountId: row.to_account_id,
    categoryId: row.category_id,
    payee: row.payee || '',
    note: row.note || '',
    frequency: row.frequency,
    intervalDays: row.interval_days,
    weekdays: row.weekdays ? JSON.parse(row.weekdays) : [],
    monthDay: row.month_day,
    yearMonth: row.year_month,
    yearDay: row.year_day,
    startDate: row.start_date,
    endDate: row.end_date,
    time: row.time || '09:00',
    nextRun: row.next_run,
    paused: !!row.paused,
  };
}

export function loadRule(row) {
  return mapRule(row);
}

function scheduleOf(rule) {
  return {
    frequency: rule.frequency,
    intervalDays: rule.intervalDays,
    weekdays: rule.weekdays,
    monthDay: rule.monthDay,
    yearMonth: rule.yearMonth,
    yearDay: rule.yearDay,
    startDate: rule.startDate,
  };
}

export function initialNextRun(rule) {
  const next = firstOccurrence(scheduleOf(rule));
  if (rule.endDate && next > rule.endDate) return null;
  return next;
}

// 规则被改动后重新排期：从 from 当天往后找下一次，不要把过去的日子再补一遍
export function nextRunFrom(rule, from = todayString()) {
  let next = firstOccurrence(scheduleOf(rule));
  let guard = 0;
  while (next && next < from && guard < 500) {
    const step = advance(scheduleOf(rule), next);
    if (!step || step <= next) break;
    next = step;
    guard += 1;
  }
  if (next && rule.endDate && next > rule.endDate) return null;
  return next;
}

function insertOccurrence(rule, date) {
  const externalId = `r${rule.id}:${date}`;
  const exists = db.prepare(
    'SELECT id FROM transactions WHERE user_id = ? AND source = ? AND external_id = ?',
  ).get(rule.userId, 'recurring', externalId);
  if (exists) return;
  const time = /^\d{2}:\d{2}$/.test(rule.time) ? rule.time : '09:00';
  db.prepare(`
    INSERT INTO transactions (
      user_id, book_id, type, amount_cents, account_id, to_account_id, category_id,
      occurred_at, payee, note, source, external_id, recurring_rule_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recurring', ?, ?, ?)
  `  ).run(
    rule.userId, rule.bookId || ensurePersonalBook(rule.userId).id, rule.type, rule.amountCents, rule.accountId,
    rule.toAccountId, rule.categoryId,
    `${date} ${time}:00`, rule.payee || null, rule.note || null, externalId, rule.id, new Date().toISOString(),
  );
}

export function generateRule(rule, { through = todayString(), forceNext = false } = {}) {
  let next = rule.nextRun;
  let guard = 0;
  let created = 0;
  while (next && guard < 400) {
    if (rule.endDate && next > rule.endDate) {
      next = null;
      break;
    }
    if (next > through && !forceNext) break;
    insertOccurrence(rule, next);
    created += 1;
    next = advance(scheduleOf(rule), next);
    if (forceNext) break;
    guard += 1;
  }
  db.prepare('UPDATE recurring_rules SET next_run = ? WHERE id = ?').run(next, rule.id);
  rule.nextRun = next;
  return created;
}

export function runDue(userId) {
  const today = todayString();
  const sql = userId
    ? 'SELECT * FROM recurring_rules WHERE paused = 0 AND next_run IS NOT NULL AND next_run <= ? AND user_id = ?'
    : 'SELECT * FROM recurring_rules WHERE paused = 0 AND next_run IS NOT NULL AND next_run <= ?';
  const rows = userId ? db.prepare(sql).all(today, userId) : db.prepare(sql).all(today);
  for (const row of rows) {
    try { generateRule(mapRule(row), { through: today }); }
    catch (err) { console.error('定期入账失败', row.id, err); }
  }
}

export function pendingInMonth(rule, monthStart, monthEnd, today) {
  if (rule.paused || !rule.nextRun) return [];
  const dates = [];
  let cur = rule.nextRun;
  let guard = 0;
  while (cur && cur <= monthEnd && guard < 40) {
    if (rule.endDate && cur > rule.endDate) break;
    if (cur >= monthStart && cur > today) dates.push(cur);
    const n = advance(scheduleOf(rule), cur);
    if (!n || n <= cur) break;
    cur = n;
    guard += 1;
  }
  return dates;
}

export function startScheduler() {
  const tick = () => { try { runDue(); } catch (err) { console.error(err); } };
  tick();
  setInterval(tick, 60 * 1000).unref?.();
}

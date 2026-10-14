// 报表与查询逻辑：从 index.js 抽出来的纯业务逻辑（不依赖 req/res）。
// 负责「按条件筛选账单、统计、AA 平摊、账本作用域、时间区间」等。
import { db } from './db.js';
import { config } from './config.js';
import { centsToYuan, yuanToCents } from './money.js';
import { parseShareWith, selectTransactions } from './ledger.js';
import { monthBounds, formatDate, pad } from './dates.js';
import { canSeeBook, visibleBookIds } from './books.js';
import { normalizeAccountName, resolveCategoryPath } from './taxonomy.js';

// 账单按账本隔离：指定账本就看这一个，没指定就看自己所有的账本（个人账本 + 参与的共享/家庭账本）
export function bookScope(user, query) {
  const asked = Number(query.bookId) || 0;
  if (asked) {
    if (!canSeeBook(user, asked)) throw Object.assign(new Error('账本不存在'), { status: 404 });
    return { sql: 't.book_id = ?', params: [asked] };
  }
  const ids = visibleBookIds(user.id);
  if (!ids.length) return { sql: '0', params: [] };
  return { sql: `t.book_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

// 选账户时把合并过的账户一起带上：旧账户（merged_into 指向主账户）本身没有账单，
// 账单都挂在主账户上，所以选中任意一个都要展开成「主账户 + 它所有旧账户」。
export function expandAccountIds(ids) {
  if (!ids.length) return [];
  const parentOf = new Map(db.prepare('SELECT id, merged_into FROM accounts').all().map((row) => [row.id, row.merged_into || null]));
  function rootOf(id) {
    let current = id;
    for (let i = 0; i < 20 && parentOf.get(current); i += 1) current = parentOf.get(current);
    return current;
  }
  const roots = new Set(ids.map(rootOf));
  const out = new Set(roots);
  for (const [child, parent] of parentOf) {
    if (parent && roots.has(rootOf(parent))) out.add(child);
  }
  return [...out];
}

// 把「元」换成「分」，没填或填错了就返回 null（不参与筛选）
export function amountCents(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const cents = yuanToCents(text);
  return Number.isFinite(cents) ? cents : null;
}

export function transactionWhere(user, query) {
  const scope = bookScope(user, query);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.from) {
    where.push('t.occurred_at >= ?');
    params.push(String(query.from).slice(0, 10));
  }
  if (query.to) {
    where.push("t.occurred_at < date(?, '+1 day')");
    params.push(String(query.to).slice(0, 10));
  }
  // 账户筛选，支持多个 id。转账的转出/转入账户都要算进来
  const accountIds = expandAccountIds(String(query.accountIds || query.accountId || '')
    .split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0));
  if (accountIds.length) {
    const marks = accountIds.map(() => '?').join(',');
    where.push(`(t.account_id IN (${marks}) OR t.to_account_id IN (${marks}))`);
    params.push(...accountIds, ...accountIds);
  }
  if (['expense', 'income', 'transfer'].includes(String(query.type || ''))) {
    where.push('t.type = ?');
    params.push(String(query.type));
  }
  if (['manual', 'wechat', 'alipay', 'jd', 'qianji', 'recurring', 'custom', 'cmb'].includes(String(query.source || ''))) {
    where.push('t.source = ?');
    params.push(String(query.source));
  }
  // 按成员（付款人/收款人）筛选，出游/家庭账本用；传 none 表示没填成员
  const memberName = String(query.memberName || '').trim();
  if (memberName) {
    if (memberName === 'none') where.push("(t.member_name IS NULL OR TRIM(t.member_name) = '')");
    else {
      // 汇总里是按 TRIM 后的名字聚合的，筛选也要 TRIM，否则带空格的旧数据点不开
      where.push("TRIM(COALESCE(t.member_name, '')) = ?");
      params.push(memberName);
    }
  }
  // 按一级分类筛选：命中二级分类时也算进来，支持多个 id（同名分类）
  // 传 none 表示「未分类」：账单没有分类，或分类记录已不存在
  const categoryParts = String(query.categoryIds || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const categoryIds = categoryParts
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  const wantUncategorized = categoryParts.some((value) => value === 'none' || value === '0');
  const categoryClauses = [];
  if (categoryIds.length) {
    const marks = categoryIds.map(() => '?').join(',');
    categoryClauses.push(`(c.id IN (${marks}) OR p.id IN (${marks}))`);
    params.push(...categoryIds, ...categoryIds);
  }
  if (wantUncategorized) categoryClauses.push('(t.category_id IS NULL OR c.id IS NULL)');
  if (categoryClauses.length) where.push(`(${categoryClauses.join(' OR ')})`);
  // 按分类名筛选：共享账本里手填的分类只存了文本（没有 category_id），只能用名字匹配
  const categoryLabel = String(query.categoryLabel || '').trim();
  if (categoryLabel) {
    where.push('(t.category_label = ? OR c.name = ? OR p.name = ?)');
    params.push(categoryLabel, categoryLabel, categoryLabel);
  }
  // 金额区间，单位是元
  const minCents = amountCents(query.minAmount);
  if (minCents !== null) {
    where.push('t.amount_cents >= ?');
    params.push(minCents);
  }
  const maxCents = amountCents(query.maxAmount);
  if (maxCents !== null) {
    where.push('t.amount_cents <= ?');
    params.push(maxCents);
  }
  // 关键词：空格分词，每个词都要命中（AND）。
  // 覆盖界面上看得见的所有字段：对方、备注、分类、账户、成员、自定义分类、金额、类型
  const keyword = String(query.q || '').trim();
  if (keyword) {
    const words = keyword.split(/\s+/).filter(Boolean).slice(0, config.pagination.keywordMaxWords);
    for (const word of words) {
      const like = `%${word}%`;
      where.push(`(
        t.payee LIKE ? OR t.note LIKE ? OR c.name LIKE ? OR p.name LIKE ?
        OR a.name LIKE ? OR b.name LIKE ? OR t.member_name LIKE ? OR t.category_label LIKE ?
        OR printf('%.2f', t.amount_cents / 100.0) LIKE ?
        OR CASE t.type WHEN 'expense' THEN '支出' WHEN 'income' THEN '收入' ELSE '转账' END LIKE ?
      )`);
      params.push(like, like, like, like, like, like, like, like, like, like);
    }
  }
  return { where, params };
}

// 账单排序。默认按时间倒序；按金额排时，同额再按时间倒序。
// 绝对值排序用来把「大额的收入和支出」一起挑出来，不看收支方向。
export const TRANSACTION_SORTS = {
  amount_asc: 't.amount_cents ASC, t.occurred_at DESC, t.id DESC',
  amount_desc: 't.amount_cents DESC, t.occurred_at DESC, t.id DESC',
  amount_abs: 'ABS(t.amount_cents) DESC, t.occurred_at DESC, t.id DESC',
};

export function transactionRows(user, query, limit, offset) {
  const { where, params } = transactionWhere(user, query);
  const order = TRANSACTION_SORTS[String(query.sort || '')] || 't.occurred_at DESC, t.id DESC';
  const sql = `
    ${selectTransactions()}
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}
    ${limit ? 'LIMIT ?' : ''}
    ${limit && offset ? 'OFFSET ?' : ''}
  `;
  if (limit) params.push(limit);
  if (limit && offset) params.push(offset);
  return db.prepare(sql).all(...params);
}

// 按当前筛选条件统计笔数和金额。金额只算支出和收入，转账是资金搬家不计入
// 把金额（分）平均分成 count 份，余数一分一分补给前面的人，保证几份加起来正好等于总额
export function splitEvenly(cents, count) {
  const base = Math.trunc(cents / count);
  let leftover = cents - base * count;
  return Array.from({ length: count }, () => {
    let extra = 0;
    if (leftover !== 0) {
      extra = leftover > 0 ? 1 : -1;
      leftover -= extra;
    }
    return base + extra;
  });
}

// AA 平摊。逐笔算：每笔账单按它自己勾选的分摊人平分，打车这种「每天坐车的人不一样」就靠这个。
// 没设过分摊人的老账单退回「全员平分」，行为跟以前一样。
// billRows 是逐笔的（不聚合）：[{ kind, member_name, amount_cents, share_with }]
export function computeAa(billRows, presetNames = []) {
  const paid = new Map();      // 自己垫的钱
  const excluded = new Map();  // 声明自己承担的，不进 AA
  const share = new Map();     // 该摊多少
  const payerNames = new Set();
  const sharerNames = new Set();
  let legacyPool = 0;          // 没设分摊人的老账单：走全员平分
  let aaPool = 0;              // 参与平摊的总额
  let unassigned = 0;          // 没填付款人的部分

  for (const row of billRows || []) {
    const amount = Number(row.amount_cents) || 0;
    if (!amount) continue;
    const signed = row.kind === 'income' ? -amount : amount; // 收入当退款，抵掉垫付
    const payer = row.member_name && row.member_name !== '未填' ? row.member_name : null;
    if (payer) {
      payerNames.add(payer);
      paid.set(payer, (paid.get(payer) || 0) + signed);
    } else {
      unassigned += signed;
    }
    const picked = parseShareWith(row.share_with);
    if (picked === null) {   // 老账单 / 没设过：进全员平分的池子
      legacyPool += signed;
      aaPool += signed;
      continue;
    }
    if (!picked.length) {    // 一个都没勾：付款人自己承担，不算 AA
      if (payer) excluded.set(payer, (excluded.get(payer) || 0) + signed);
      continue;
    }
    aaPool += signed;
    const heads = splitEvenly(signed, picked.length);
    picked.forEach((name, index) => {
      sharerNames.add(name);
      share.set(name, (share.get(name) || 0) + heads[index]);
    });
  }

  const legacySharers = [...new Set([...presetNames, ...payerNames])];
  if (legacyPool && legacySharers.length) {
    const heads = splitEvenly(legacyPool, legacySharers.length);
    legacySharers.forEach((name, index) => share.set(name, (share.get(name) || 0) + heads[index]));
  }

  const names = [...new Set([...presetNames, ...payerNames, ...sharerNames])]
    .sort((a, b) => (paid.get(b) || 0) - (paid.get(a) || 0));
  const diff = new Map();
  const members = names.map((name) => {
    // 自己承担的（请客）不进 AA：垫付里先扣掉，不然「垫付 − 应摊」对不上差额
    const own = excluded.get(name) || 0;
    const inAa = (paid.get(name) || 0) - own;
    const value = inAa - (share.get(name) || 0);
    diff.set(name, value);
    return {
      name,
      paid: centsToYuan(inAa),
      share: centsToYuan(share.get(name) || 0),
      diff: centsToYuan(value),
      own: centsToYuan(own),
    };
  });
  const creditors = names.filter((n) => diff.get(n) > 0).map((n) => ({ name: n, cents: diff.get(n) }));
  const debtors = names.filter((n) => diff.get(n) < 0).map((n) => ({ name: n, cents: -diff.get(n) }));
  creditors.sort((a, b) => b.cents - a.cents);
  debtors.sort((a, b) => b.cents - a.cents);
  const transfers = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const amount = Math.min(creditors[ci].cents, debtors[di].cents);
    if (amount > 0) {
      transfers.push({ from: debtors[di].name, to: creditors[ci].name, amount: centsToYuan(amount) });
    }
    creditors[ci].cents -= amount;
    debtors[di].cents -= amount;
    if (creditors[ci].cents <= 0) ci += 1;
    if (debtors[di].cents <= 0) di += 1;
  }
  return {
    total: centsToYuan(aaPool),
    perPerson: centsToYuan(names.length ? Math.round(aaPool / names.length) : 0),
    memberCount: names.length,
    unassigned: centsToYuan(unassigned),
    members,
    transfers,
  };
}

export function transactionTotal(user, query) {
  const { where, params } = transactionWhere(user, query);
  const row = db.prepare(`
    SELECT
      COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_cents END), 0) AS expense,
      COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents END), 0) AS income
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts b ON b.id = t.to_account_id
    WHERE ${where.join(' AND ')}
  `).get(...params);
  return { count: row.n, expenseCents: row.expense, incomeCents: row.income };
}

// 统一解析时间区间：优先用 from/to，否则退回 year/month
export function resolveBounds(query, now = new Date()) {
  if (query.from && query.to) {
    return { start: String(query.from).slice(0, 10), end: String(query.to).slice(0, 10) };
  }
  const year = Number(query.year) || now.getFullYear();
  const month = Number(query.month) || now.getMonth() + 1;
  return monthBounds(year, month);
}

// '2026-09-01' 按本地时区解析，避免 UTC 偏移把日期挪到前一天
export function parseLocalDate(text) {
  const s = String(text).slice(0, 10);
  return new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
}

export function daysBetween(start, end) {
  return Math.round((parseLocalDate(end) - parseLocalDate(start)) / 86400000) + 1;
}

export function eachDay(start, end) {
  const days = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    days.push(formatDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function eachMonth(start, end) {
  const months = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor <= last) {
    months.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

// 预览时告诉前端真正会新建哪些账户/分类：按统一归类算，不再按账单原名一个一个建。
export function previewNewNames(userId, rows) {
  const accountNames = new Set(
    db.prepare('SELECT name FROM accounts WHERE user_id = ?').all(userId).map((r) => r.name),
  );
  for (const row of db.prepare('SELECT alias FROM account_aliases WHERE user_id = ?').all(userId)) {
    accountNames.add(row.alias);
  }
  const categories = new Map();
  for (const row of db.prepare('SELECT name, kind FROM categories WHERE user_id = ? AND archived = 0').all(userId)) {
    const key = `${row.kind}\0${row.name}`;
    if (!categories.has(key)) categories.set(key, true);
  }
  const newAccounts = new Set();
  const newCategories = new Set();
  for (const row of rows) {
    if (row.skipReason) continue;
    for (const raw of [row.accountName, row.toAccountName]) {
      const name = normalizeAccountName(raw);
      if (name && !accountNames.has(name)) newAccounts.add(name);
    }
    if (row.type === 'transfer' || !row.categoryName) continue;
    const path = resolveCategoryPath(row.categoryName, row.type);
    if (!path) continue; // 认不出来的落「其他」，不算新增
    const leaf = path[1] || path[0];
    const key = `${row.type}\0${leaf}`;
    if (!categories.has(key)) newCategories.add(`${leaf}`);
  }
  return { newAccounts: [...newAccounts], newCategories: [...newCategories] };
}

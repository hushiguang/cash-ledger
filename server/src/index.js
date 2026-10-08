import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

// Docker 默认网络没有 IPv6。Node 默认按系统返回顺序解析，会先试 IPv6 导致 ENETUNREACH。
// 这里改成优先 IPv4，图床等外部请求才不会卡在不可达的 IPv6 地址上。
dns.setDefaultResultOrder('ipv4first');
import cors from 'cors';
import multer from 'multer';
import { db } from './db.js';
import { centsToYuan, yuanToCents } from './money.js';
import { formatDate, monthBounds, normalizeClientDate, pad, todayString } from './dates.js';
import {
  adminRequired,
  allowRegister,
  authRequired,
  checkPassword,
  hashPassword,
  publicUser,
  signUser,
} from './auth.js';
import { seedUser } from './seed.js';
import {
  ACCOUNT_SQL,
  accountOwned,
  categoryOwned,
  deleteAccountAlias,
  ensureAccount,
  ensureCategory,
  listAccountAliases,
  mergeAccount,
  presentAccount,
  presentTransaction,
  resolveAccount,
  saveAccountAlias,
  selectTransactions,
  unmergeAccount,
} from './ledger.js';
import {
  bookById,
  bookByShareToken,
  bookKindLabel,
  bookMembers,
  canManageBook,
  canSeeBook,
  canWriteBook,
  ensurePersonalBook,
  newShareToken,
  presentBook,
  roleInBook,
  saveImages,
  transactionImages,
  visibleBookIds,
} from './books.js';
import { fetchImage, isAllowedImageUrl, uploadImage } from './imagehost.js';
import { parseFile } from './importers.js';
import { findDuplicatePairs, groupDuplicates, ignorePair, listIgnores, unignorePair } from './duplicates.js';
import { normalizeAccountName, resolveCategoryPath } from './taxonomy.js';
import { toCsv, toXlsx } from './export.js';
import {
  generateRule,
  initialNextRun,
  loadRule,
  pendingInMonth,
  startScheduler,
} from './recurring.js';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));

function fail(res, status, message) {
  return res.status(status).json({ message });
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function presentCategory(row) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    kind: row.kind,
    archived: !!row.archived,
  };
}

function readAmount(value) {
  const cents = yuanToCents(value);
  if (cents == null || cents <= 0) return null;
  return cents;
}

function presentRule(row) {
  const rule = loadRule(row);
  return {
    id: rule.id,
    bookId: rule.bookId,
    type: rule.type,
    amount: centsToYuan(rule.amountCents),
    accountId: rule.accountId,
    toAccountId: rule.toAccountId,
    categoryId: rule.categoryId,
    payee: rule.payee,
    note: rule.note,
    frequency: rule.frequency,
    intervalDays: rule.intervalDays,
    weekdays: rule.weekdays,
    monthDay: rule.monthDay,
    yearMonth: rule.yearMonth,
    yearDay: rule.yearDay,
    startDate: rule.startDate,
    endDate: rule.endDate,
    time: rule.time,
    nextRun: rule.nextRun,
    paused: rule.paused,
  };
}

function ruleFromBody(userId, body) {
  const type = body.type;
  if (!['expense', 'income', 'transfer'].includes(type)) throw Object.assign(new Error('类型不正确'), { status: 400 });
  const amountCents = readAmount(body.amount);
  if (amountCents == null) throw Object.assign(new Error('金额不正确'), { status: 400 });
  const account = accountOwned(userId, Number(body.accountId));
  if (!account) throw Object.assign(new Error('请选择账户'), { status: 400 });
  let toAccountId = null;
  let categoryId = null;
  if (type === 'transfer') {
    const to = accountOwned(userId, Number(body.toAccountId));
    if (!to || to.id === account.id) throw Object.assign(new Error('请选择不同的转入账户'), { status: 400 });
    toAccountId = to.id;
  } else if (body.categoryId) {
    const category = categoryOwned(userId, Number(body.categoryId));
    if (!category || category.kind !== type) throw Object.assign(new Error('分类不匹配'), { status: 400 });
    categoryId = category.id;
  }
  const frequency = body.frequency;
  if (!['daily', 'interval', 'weekly', 'monthly', 'yearly'].includes(frequency)) {
    throw Object.assign(new Error('周期不正确'), { status: 400 });
  }
  const startDate = String(body.startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw Object.assign(new Error('开始日期不正确'), { status: 400 });
  const endDate = body.endDate ? String(body.endDate).slice(0, 10) : null;
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw Object.assign(new Error('结束日期不正确'), { status: 400 });
  const weekdays = Array.isArray(body.weekdays)
    ? body.weekdays.map(Number).filter((n) => n >= 1 && n <= 7)
    : [];
  return {
    userId,
    type,
    amountCents,
    accountId: account.id,
    toAccountId,
    categoryId,
    payee: String(body.payee || '').trim(),
    note: String(body.note || '').trim(),
    frequency,
    intervalDays: Math.max(1, Number(body.intervalDays) || 1),
    weekdays,
    monthDay: Number(body.monthDay) || Number(startDate.slice(8, 10)),
    yearMonth: Number(body.yearMonth) || Number(startDate.slice(5, 7)),
    yearDay: Number(body.yearDay) || Number(startDate.slice(8, 10)),
    startDate,
    endDate,
    time: /^\d{2}:\d{2}$/.test(body.time || '') ? body.time : '09:00',
  };
}

function insertTransaction(user, body, source = 'manual', externalId = null, recurringRuleId = null) {
  const userId = user.id;
  const type = body.type;
  if (!['expense', 'income', 'transfer'].includes(type)) {
    throw Object.assign(new Error('类型不正确'), { status: 400 });
  }
  const amountCents = body.amountCents ?? readAmount(body.amount);
  if (amountCents == null || amountCents <= 0) throw Object.assign(new Error('金额不正确'), { status: 400 });
  // 账本：不传就用个人账本，传了必须有记账权限
  const book = body.bookId ? canSeeBook(user, Number(body.bookId)) : ensurePersonalBook(userId);
  if (!book) throw Object.assign(new Error('账本不存在'), { status: 404 });
  if (!canWriteBook(user, book)) throw Object.assign(new Error('没有这个账本的记账权限'), { status: 403 });
  // 共享账本可以不填账户；分类沿用账本 owner 的那套
  const shared = book.kind !== 'personal';
  const taxonomyUserId = book.owner_id;
  // 共享账本补账时不强求时间，默认记成现在
  const occurredAt = normalizeClientDate(body.occurredAt)
    || (shared ? normalizeClientDate(`${todayString()} ${pad(new Date().getHours())}:${pad(new Date().getMinutes())}:00`) : null);
  if (!occurredAt) throw Object.assign(new Error('时间不正确'), { status: 400 });
  const namedAccount = (name) => resolveAccount(userId, name) || ensureAccount(userId, name);
  let account = body.accountId
    ? accountOwned(userId, Number(body.accountId))
    : (body.accountName ? namedAccount(body.accountName) : null);
  if (!account && (type === 'transfer' || !shared)) throw Object.assign(new Error('请选择账户'), { status: 400 });
  let toAccountId = null;
  let categoryId = null;
  let categoryLabel = null;
  if (type === 'transfer') {
    const toName = String(body.toAccountName || '').trim();
    if (body.incoming) {
      const counterparty = namedAccount(body.payee || '外部');
      if (counterparty.id !== account.id) {
        toAccountId = account.id;
        account = counterparty;
      }
    } else if (body.toAccountId || toName) {
      const to = body.toAccountId
        ? accountOwned(userId, Number(body.toAccountId))
        : namedAccount(toName);
      if (!to || (to.id === account.id && source === 'manual')) {
        throw Object.assign(new Error('请选择不同的转入账户'), { status: 400 });
      }
      toAccountId = to.id;
    } else if (source === 'manual') {
      throw Object.assign(new Error('请选择不同的转入账户'), { status: 400 });
    }
  } else if (body.categoryId) {
    const category = categoryOwned(taxonomyUserId, Number(body.categoryId));
    if (!category || category.kind !== type) throw Object.assign(new Error('分类不匹配'), { status: 400 });
    categoryId = category.id;
  } else if (body.categoryName || body.subcategoryName) {
    categoryId = ensureCategory(taxonomyUserId, type, body.categoryName, body.subcategoryName).id;
  } else if (body.categoryLabel) {
    // 共享账本里手写的分类：能对齐到已有分类就对齐，否则只存文本
    const label = String(body.categoryLabel).trim();
    if (label) {
      const hit = db.prepare(
        'SELECT * FROM categories WHERE user_id = ? AND kind = ? AND name = ?',
      ).get(taxonomyUserId, type, label);
      if (hit) categoryId = hit.id;
      else categoryLabel = label;
    }
  }
  const memberName = String(body.memberName || '').trim() || null;
  const info = db.prepare(`
    INSERT OR IGNORE INTO transactions (
      user_id, book_id, type, amount_cents, account_id, to_account_id, category_id, category_label,
      occurred_at, payee, note, member_name, source, external_id, recurring_rule_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    book.owner_id, book.id, type, amountCents, account ? account.id : null, toAccountId, categoryId, categoryLabel,
    occurredAt, body.payee || null, body.note || null, memberName, source, externalId || null,
    recurringRuleId, new Date().toISOString(),
  );
  if (info.changes && Array.isArray(body.images)) saveImages(Number(info.lastInsertRowid), body.images);
  return info;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/config', (_req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ allowRegister: allowRegister() || users === 0, hasUsers: users > 0 });
});

app.post('/api/auth/register', wrap((req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (users > 0 && !allowRegister()) return fail(res, 403, '已关闭注册');
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || username).trim();
  if (username.length < 2 || username.length > 32) return fail(res, 400, '用户名需要 2 到 32 个字符');
  if (password.length < 6) return fail(res, 400, '密码至少 6 位');
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return fail(res, 409, '用户名已存在');
  const created = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, hashPassword(password), displayName || username, users === 0 ? 1 : 0, new Date().toISOString());
  const id = Number(created.lastInsertRowid);
  seedUser(id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ token: signUser(row), user: publicUser(row) });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !checkPassword(password, row.password_hash)) return fail(res, 401, '用户名或密码错误');
  if (!row.is_active) return fail(res, 403, '账号已停用');
  res.json({ token: signUser(row), user: publicUser(row) });
}));

app.get('/api/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/users', authRequired, adminRequired, (_req, res) => {
  const rows = db.prepare(`
    SELECT id, username, display_name, is_admin, is_active, created_at
    FROM users ORDER BY id
  `).all();
  res.json({ users: rows.map(publicUser) });
});

app.patch('/api/users/:id', authRequired, adminRequired, wrap((req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '用户不存在');
  if (req.body.displayName != null) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(req.body.displayName).trim() || row.display_name, id);
  }
  if (req.body.isActive != null) {
    if (id === req.user.id && !req.body.isActive) return fail(res, 400, '不能停用自己');
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(req.body.isActive ? 1 : 0, id);
  }
  if (req.body.isAdmin != null) {
    if (id === req.user.id && !req.body.isAdmin) return fail(res, 400, '不能取消自己的管理员');
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.isAdmin ? 1 : 0, id);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) return fail(res, 400, '密码至少 6 位');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.password)), id);
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
}));

app.get('/api/accounts', authRequired, (req, res) => {
  const rows = db.prepare(`${ACCOUNT_SQL} WHERE a.user_id = ? ORDER BY a.sort, a.id`).all(req.user.id);
  res.json({ accounts: rows.map(presentAccount) });
});

app.post('/api/accounts', authRequired, wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return fail(res, 400, '请填写账户名');
  const kind = String(req.body.kind || 'other');
  const initial = yuanToCents(req.body.initial ?? 0) ?? 0;
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM accounts WHERE user_id = ?').get(req.user.id).n;
  const created = db.prepare(
    'INSERT INTO accounts (user_id, name, kind, initial_cents, sort) VALUES (?, ?, ?, ?, ?)',
  ).run(req.user.id, name, kind, initial, sort);
  const row = db.prepare(`${ACCOUNT_SQL} WHERE a.id = ?`).get(Number(created.lastInsertRowid));
  res.json({ account: presentAccount(row) });
}));

app.patch('/api/accounts/:id', authRequired, wrap((req, res) => {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!row) return fail(res, 404, '账户不存在');
  const name = req.body.name != null ? String(req.body.name).trim() : row.name;
  const kind = req.body.kind != null ? String(req.body.kind) : row.kind;
  const archived = req.body.archived != null ? (req.body.archived ? 1 : 0) : row.archived;
  const initial = req.body.initial != null ? (yuanToCents(req.body.initial) ?? row.initial_cents) : row.initial_cents;
  db.prepare('UPDATE accounts SET name = ?, kind = ?, archived = ?, initial_cents = ? WHERE id = ?').run(name, kind, archived, initial, row.id);
  res.json({ account: presentAccount(db.prepare(`${ACCOUNT_SQL} WHERE a.id = ?`).get(row.id)) });
}));

// 账户归并设置：哪些账户算同一个，导入和统计都按统一账户走。
app.post('/api/accounts/merge', authRequired, wrap((req, res) => {
  const target = mergeAccount(req.user.id, req.body.sourceId, req.body.targetId);
  res.json({ account: presentAccount(db.prepare(`${ACCOUNT_SQL} WHERE a.id = ?`).get(target.id)) });
}));

app.post('/api/accounts/unmerge', authRequired, wrap((req, res) => {
  const row = unmergeAccount(req.user.id, req.body.accountId);
  res.json({ account: presentAccount(db.prepare(`${ACCOUNT_SQL} WHERE a.id = ?`).get(row.id)) });
}));

app.get('/api/account-aliases', authRequired, (req, res) => {
  res.json({ aliases: listAccountAliases(req.user.id) });
});

app.post('/api/account-aliases', authRequired, wrap((req, res) => {
  saveAccountAlias(req.user.id, req.body.alias, req.body.accountId);
  res.json({ aliases: listAccountAliases(req.user.id) });
}));

app.delete('/api/account-aliases/:id', authRequired, wrap((req, res) => {
  deleteAccountAlias(req.user.id, req.params.id);
  res.json({ aliases: listAccountAliases(req.user.id) });
}));

app.get('/api/categories', authRequired, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM categories WHERE user_id = ? ORDER BY kind, parent_id IS NOT NULL, sort, id',
  ).all(req.user.id);
  res.json({ categories: rows.map(presentCategory) });
});

app.post('/api/categories', authRequired, wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  const kind = req.body.kind === 'income' ? 'income' : 'expense';
  if (!name) return fail(res, 400, '请填写分类名');
  let parentId = null;
  if (req.body.parentId) {
    const parent = categoryOwned(req.user.id, Number(req.body.parentId));
    if (!parent || parent.kind !== kind || parent.parent_id) return fail(res, 400, '上级分类不正确');
    parentId = parent.id;
  }
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories WHERE user_id = ?').get(req.user.id).n;
  try {
    const created = db.prepare(
      'INSERT INTO categories (user_id, name, parent_id, kind, sort) VALUES (?, ?, ?, ?, ?)',
    ).run(req.user.id, name, parentId, kind, sort);
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(created.lastInsertRowid));
    res.json({ category: presentCategory(row) });
  } catch {
    fail(res, 409, '同类型下已有这个分类');
  }
}));

// 归档过的分类也要能查到，恢复时用
function categoryRow(userId, id) {
  return db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

function categoryWithChildren(row) {
  const children = db.prepare('SELECT * FROM categories WHERE parent_id = ?').all(row.id);
  return [row, ...children];
}

function categoryInUse(userId, ids) {
  const marks = ids.map(() => '?').join(',');
  const used = db.prepare(
    `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND category_id IN (${marks})`,
  ).get(userId, ...ids).n;
  return used > 0;
}

app.patch('/api/categories/:id', authRequired, wrap((req, res) => {
  const row = categoryRow(req.user.id, req.params.id);
  if (!row) return fail(res, 404, '分类不存在');
  let name = row.name;
  if (req.body.name != null) {
    name = String(req.body.name).trim();
    if (!name) return fail(res, 400, '请填写分类名');
    if (name !== row.name) {
      const dup = db.prepare(
        'SELECT id FROM categories WHERE user_id = ? AND kind = ? AND name = ? AND id <> ?',
      ).get(req.user.id, row.kind, name, row.id);
      if (dup) return fail(res, 409, '同类型下已有这个分类');
    }
  }
  let parentId = row.parent_id;
  if (req.body.parentId !== undefined) {
    const next = Number(req.body.parentId) || null;
    if (next === row.id) return fail(res, 400, '上级分类不正确');
    if (next == null) {
      parentId = null;
    } else {
      const parent = categoryOwned(req.user.id, next);
      if (!parent || parent.kind !== row.kind || parent.parent_id) return fail(res, 400, '上级分类不正确');
      parentId = parent.id;
    }
  }
  const archived = req.body.archived != null ? (req.body.archived ? 1 : 0) : row.archived;
  db.prepare('UPDATE categories SET name = ?, parent_id = ?, archived = ? WHERE id = ?')
    .run(name, parentId, archived, row.id);
  // 恢复一级分类时，它的二级分类跟着一起恢复
  if (!archived && !parentId) {
    db.prepare('UPDATE categories SET archived = 0 WHERE parent_id = ?').run(row.id);
  }
  res.json({ category: presentCategory(categoryRow(req.user.id, row.id)) });
}));

// 有账单在用的分类只归档，没人用才真删；一级分类连子分类一起处理
app.delete('/api/categories/:id', authRequired, wrap((req, res) => {
  const row = categoryRow(req.user.id, req.params.id);
  if (!row) return fail(res, 404, '分类不存在');
  const group = categoryWithChildren(row);
  const ids = group.map((item) => item.id);
  if (categoryInUse(req.user.id, ids)) {
    const marks = ids.map(() => '?').join(',');
    db.prepare(`UPDATE categories SET archived = 1 WHERE id IN (${marks})`).run(...ids);
    return res.json({ archived: true, deleted: false });
  }
  const marks = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM category_aliases WHERE user_id = ? AND category_id IN (${marks})`).run(req.user.id, ...ids);
  db.prepare(`DELETE FROM categories WHERE id IN (${marks})`).run(...ids);
  res.json({ archived: false, deleted: true });
}));

// 一键清理已归档：没有账单在用（且没有还会用到的子分类）的才真删
app.post('/api/categories/prune', authRequired, wrap((req, res) => {
  const rows = db.prepare('SELECT id FROM categories WHERE user_id = ? AND archived = 1').all(req.user.id);
  let deleted = 0;
  let kept = 0;
  const gone = new Set();
  for (const row of rows) {
    if (gone.has(row.id)) continue; // 已经随上级分类一起删掉了
    const children = db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(row.id);
    const ids = [row.id, ...children.map((c) => c.id)];
    if (categoryInUse(req.user.id, ids)) {
      kept += 1;
      continue;
    }
    const marks = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM category_aliases WHERE user_id = ? AND category_id IN (${marks})`).run(req.user.id, ...ids);
    db.prepare(`DELETE FROM categories WHERE id IN (${marks})`).run(...ids);
    ids.forEach((id) => gone.add(id));
    deleted += ids.length;
  }
  res.json({ ok: true, deleted, kept });
}));

function presentWithImages(row) {
  return presentTransaction(row, transactionImages([row.id]).get(row.id) || []);
}

function bookPayload(user, row) {
  const members = bookMembers(row.id);
  return presentBook(row, {
    role: roleInBook(user, row),
    ownerName: members.find((m) => m.user_id === row.owner_id)?.display_name || '',
    members: members.map((m) => ({ id: m.user_id, name: m.display_name, username: m.username, role: m.role })),
  });
}

app.get('/api/books', authRequired, (req, res) => {
  const mine = db.prepare(`
    SELECT * FROM books
    WHERE owner_id = ? OR id IN (SELECT book_id FROM book_members WHERE user_id = ?)
    ORDER BY archived, kind, id
  `).all(req.user.id, req.user.id);
  // 管理员额外能看到所有人的账本
  let rows = mine;
  if (req.user.isAdmin) {
    const others = db.prepare(`
      SELECT * FROM books
      WHERE owner_id <> ? AND id NOT IN (SELECT book_id FROM book_members WHERE user_id = ?)
      ORDER BY owner_id, id
    `).all(req.user.id, req.user.id);
    rows = [...mine, ...others];
  }
  res.json({ books: rows.map((row) => bookPayload(req.user, row)) });
});

app.post('/api/books', authRequired, wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return fail(res, 400, '请填写账本名');
  const kind = ['personal', 'travel', 'family'].includes(req.body.kind) ? req.body.kind : 'travel';
  if (kind === 'personal' && db.prepare(
    "SELECT id FROM books WHERE owner_id = ? AND kind = 'personal'",
  ).get(req.user.id)) {
    return fail(res, 409, '已经有一个个人账本了');
  }
  const now = new Date().toISOString();
  try {
    const info = db.prepare(
      'INSERT INTO books (owner_id, name, kind, created_at) VALUES (?, ?, ?, ?)',
    ).run(req.user.id, name, kind, now);
    const id = Number(info.lastInsertRowid);
    db.prepare(
      'INSERT OR IGNORE INTO book_members (book_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, req.user.id, 'owner', now);
    res.json({ book: bookPayload(req.user, bookById(id)) });
  } catch {
    fail(res, 409, '已经有同名账本了');
  }
}));

app.patch('/api/books/:id', authRequired, wrap((req, res) => {
  const row = bookById(req.params.id);
  if (!row || !canManageBook(req.user, row)) return fail(res, 404, '账本不存在');
  const name = req.body.name != null ? String(req.body.name).trim() : row.name;
  if (!name) return fail(res, 400, '请填写账本名');
  const archived = req.body.archived != null ? (req.body.archived ? 1 : 0) : row.archived;
  try {
    db.prepare('UPDATE books SET name = ?, archived = ? WHERE id = ?').run(name, archived, row.id);
  } catch {
    return fail(res, 409, '已经有同名账本了');
  }
  res.json({ book: bookPayload(req.user, bookById(row.id)) });
}));

app.delete('/api/books/:id', authRequired, wrap((req, res) => {
  const row = bookById(req.params.id);
  if (!row || !canManageBook(req.user, row)) return fail(res, 404, '账本不存在');
  if (row.kind === 'personal') return fail(res, 400, '个人账本不能删除');
  const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE book_id = ?').get(row.id).n;
  if (used > 0) {
    db.prepare('UPDATE books SET archived = 1, share_enabled = 0 WHERE id = ?').run(row.id);
    return res.json({ archived: true, deleted: false });
  }
  db.prepare('DELETE FROM books WHERE id = ?').run(row.id);
  res.json({ archived: false, deleted: true });
}));

app.post('/api/books/:id/members', authRequired, wrap((req, res) => {
  const row = bookById(req.params.id);
  if (!row || !canManageBook(req.user, row)) return fail(res, 404, '账本不存在');
  if (row.kind === 'personal') return fail(res, 400, '个人账本不能加成员');
  const username = String(req.body.username || '').trim();
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) return fail(res, 404, '用户不存在');
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO book_members (book_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run(row.id, target.id, 'member', now);
  res.json({ book: bookPayload(req.user, bookById(row.id)) });
}));

app.delete('/api/books/:id/members/:userId', authRequired, wrap((req, res) => {
  const row = bookById(req.params.id);
  if (!row || !canManageBook(req.user, row)) return fail(res, 404, '账本不存在');
  const userId = Number(req.params.userId);
  if (userId === row.owner_id) return fail(res, 400, '不能移除账本所有者');
  db.prepare('DELETE FROM book_members WHERE book_id = ? AND user_id = ?').run(row.id, userId);
  res.json({ book: bookPayload(req.user, bookById(row.id)) });
}));

// 分享链接：开就生成 token，关就作废
app.post('/api/books/:id/share', authRequired, wrap((req, res) => {
  const row = bookById(req.params.id);
  if (!row || !canManageBook(req.user, row)) return fail(res, 404, '账本不存在');
  if (row.kind === 'personal') return fail(res, 400, '个人账本不能分享');
  const enabled = req.body.enabled === false || req.body.enabled === 'false' ? 0 : 1;
  const token = enabled ? (row.share_token || newShareToken()) : row.share_token;
  db.prepare('UPDATE books SET share_enabled = ?, share_token = ? WHERE id = ?').run(enabled, token, row.id);
  res.json({ book: bookPayload(req.user, bookById(row.id)) });
}));

// 免登录补账：拿到分享链接就能看账本、加一笔
app.get('/api/share/:token', (req, res) => {
  const book = bookByShareToken(req.params.token);
  if (!book) return fail(res, 404, '链接已失效');
  const rows = transactionRows({ id: book.owner_id, isAdmin: false }, { bookId: book.id }, 200);
  const images = transactionImages(rows.map((row) => row.id));
  res.json({
    book: { id: book.id, name: book.name, kind: book.kind, kindLabel: bookKindLabel(book.kind) },
    entries: rows.map((row) => presentTransaction(row, images.get(row.id) || [])),
  });
});

app.post('/api/share/:token/entries', wrap((req, res) => {
  const book = bookByShareToken(req.params.token);
  if (!book) return fail(res, 404, '链接已失效');
  const memberName = String(req.body.memberName || '').trim();
  if (!memberName) return fail(res, 400, '请填写你的名字');
  const info = insertTransaction({ id: book.owner_id, isAdmin: false }, {
    ...req.body,
    bookId: book.id,
    memberName,
    payee: req.body.payee || null,
  }, 'shared');
  const row = db.prepare(`${selectTransactions()} WHERE t.id = ?`).get(Number(info.lastInsertRowid));
  res.json({ entry: presentWithImages(row) });
}));

// 图片：服务端转发到图床，token 不出服务端
app.post('/api/upload/image', authRequired, upload.single('image'), wrap(async (req, res) => {
  const result = await uploadImage({
    buffer: req.file?.buffer,
    mimetype: req.file?.mimetype,
    filename: req.file?.originalname,
  });
  res.json(result);
}));

app.post('/api/share/:token/upload', upload.single('image'), wrap(async (req, res) => {
  if (!bookByShareToken(req.params.token)) return fail(res, 404, '链接已失效');
  const result = await uploadImage({
    buffer: req.file?.buffer,
    mimetype: req.file?.mimetype,
    filename: req.file?.originalname,
  });
  res.json(result);
}));

// 图床是自签证书，浏览器直连会加载失败，统一走这里代理
app.get('/api/image', wrap(async (req, res) => {
  const url = String(req.query.u || '');
  if (!isAllowedImageUrl(url)) return fail(res, 400, '这个地址不允许');
  const { body, contentType } = await fetchImage(url);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(body);
}));

// 账单按账本隔离：指定账本就看这一个，没指定就看自己所有的账本（个人账本 + 参与的共享/家庭账本）
function bookScope(user, query) {
  const asked = Number(query.bookId) || 0;
  if (asked) {
    if (!canSeeBook(user, asked)) throw Object.assign(new Error('账本不存在'), { status: 404 });
    return { sql: 't.book_id = ?', params: [asked] };
  }
  const ids = visibleBookIds(user.id);
  if (!ids.length) return { sql: '0', params: [] };
  return { sql: `t.book_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

// 把「元」换成「分」，没填或填错了就返回 null（不参与筛选）
function amountCents(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const cents = yuanToCents(text);
  return Number.isFinite(cents) ? cents : null;
}

function transactionWhere(user, query) {
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
  if (['expense', 'income', 'transfer'].includes(String(query.type || ''))) {
    where.push('t.type = ?');
    params.push(String(query.type));
  }
  if (['manual', 'wechat', 'alipay', 'jd', 'qianji', 'recurring', 'custom', 'cmb'].includes(String(query.source || ''))) {
    where.push('t.source = ?');
    params.push(String(query.source));
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
  const keyword = String(query.q || '').trim();
  if (keyword) {
    where.push(`(
      t.payee LIKE ? OR t.note LIKE ? OR c.name LIKE ? OR p.name LIKE ?
      OR a.name LIKE ? OR b.name LIKE ?
      OR printf('%.2f', t.amount_cents / 100.0) LIKE ?
    )`);
    const q = `%${keyword}%`;
    params.push(q, q, q, q, q, q, q);
  }
  return { where, params };
}

// 账单排序。默认按时间倒序；按金额排时，同额再按时间倒序。
// 绝对值排序用来把「大额的收入和支出」一起挑出来，不看收支方向。
const TRANSACTION_SORTS = {
  amount_asc: 't.amount_cents ASC, t.occurred_at DESC, t.id DESC',
  amount_desc: 't.amount_cents DESC, t.occurred_at DESC, t.id DESC',
  amount_abs: 'ABS(t.amount_cents) DESC, t.occurred_at DESC, t.id DESC',
};

function transactionRows(user, query, limit) {
  const { where, params } = transactionWhere(user, query);
  const order = TRANSACTION_SORTS[String(query.sort || '')] || 't.occurred_at DESC, t.id DESC';
  const sql = `
    ${selectTransactions()}
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}
    ${limit ? 'LIMIT ?' : ''}
  `;
  if (limit) params.push(limit);
  return db.prepare(sql).all(...params);
}

function transactionTotal(user, query) {
  const { where, params } = transactionWhere(user, query);
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts b ON b.id = t.to_account_id
    WHERE ${where.join(' AND ')}
  `).get(...params);
  return row.n;
}

function attachmentName(filename) {
  return `attachment; filename="ledger.${filename.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

app.get('/api/transactions', authRequired, (req, res) => {
  const rows = transactionRows(req.user, req.query, 500);
  const total = transactionTotal(req.user, req.query);
  const images = transactionImages(rows.map((row) => row.id));
  res.json({ transactions: rows.map((row) => presentTransaction(row, images.get(row.id) || [])), total });
});

app.get('/api/export', authRequired, (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const rows = transactionRows(req.user, req.query);
  const filename = `轻账单-${todayString()}.${format}`;
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', attachmentName(filename));
    res.send(toCsv(rows));
    return;
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', attachmentName(filename));
  res.send(toXlsx(rows));
});

app.post('/api/transactions', authRequired, wrap((req, res) => {
  const info = insertTransaction(req.user, req.body);
  const row = db.prepare(`${selectTransactions()} WHERE t.id = ?`).get(Number(info.lastInsertRowid));
  res.json({ transaction: presentWithImages(row) });
}));

app.patch('/api/transactions/:id', authRequired, wrap((req, res) => {
  const current = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!current) return fail(res, 404, '账单不存在');
  const book = current.book_id ? canSeeBook(req.user, current.book_id) : ensurePersonalBook(req.user.id);
  if (!book || !canWriteBook(req.user, book)) return fail(res, 403, '没有这个账本的修改权限');
  db.prepare('DELETE FROM transactions WHERE id = ?').run(current.id);
  try {
    const info = insertTransaction(req.user, {
      type: req.body.type ?? current.type,
      amount: req.body.amount ?? centsToYuan(current.amount_cents),
      accountId: req.body.accountId ?? current.account_id,
      toAccountId: req.body.toAccountId ?? current.to_account_id,
      categoryId: req.body.categoryId ?? current.category_id,
      categoryLabel: req.body.categoryLabel ?? current.category_label,
      occurredAt: req.body.occurredAt ?? current.occurred_at,
      payee: req.body.payee ?? current.payee,
      note: req.body.note ?? current.note,
      memberName: req.body.memberName ?? current.member_name,
      bookId: current.book_id,
      images: req.body.images,
    }, current.source, current.external_id, current.recurring_rule_id);
    const row = db.prepare(`${selectTransactions()} WHERE t.id = ?`).get(Number(info.lastInsertRowid));
    res.json({ transaction: presentWithImages(row) });
  } catch (err) {
    db.prepare(`
      INSERT INTO transactions (
        id, user_id, book_id, type, amount_cents, account_id, to_account_id, category_id, category_label,
        occurred_at, payee, note, member_name, source, external_id, recurring_rule_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      current.id, current.user_id, current.book_id, current.type, current.amount_cents, current.account_id,
      current.to_account_id, current.category_id, current.category_label, current.occurred_at,
      current.payee, current.note, current.member_name,
      current.source, current.external_id, current.recurring_rule_id, current.created_at,
    );
    throw err;
  }
}));

app.get('/api/transactions/count', authRequired, wrap((req, res) => {
  res.json({ count: transactionTotal(req.user, req.query) });
}));

app.delete('/api/transactions', authRequired, wrap((req, res) => {
  if (String(req.body?.confirm || '').trim() !== '确认') return fail(res, 400, '请输入确认');
  // 只清当前账本（不传 bookId 时按可见账本范围），不会动别人的账本
  const scope = bookScope(req.user, { bookId: req.body?.bookId });
  const info = db.prepare(
    `DELETE FROM transactions WHERE id IN (SELECT t.id FROM transactions t WHERE ${scope.sql})`,
  ).run(...scope.params);
  res.json({ ok: true, deleted: info.changes });
}));

app.delete('/api/transactions/:id', authRequired, (req, res) => {
  const current = db.prepare('SELECT id, book_id, user_id FROM transactions WHERE id = ?').get(Number(req.params.id));
  if (!current) return fail(res, 404, '账单不存在');
  const book = current.book_id ? canSeeBook(req.user, current.book_id) : null;
  if (current.book_id && (!book || !canWriteBook(req.user, book))) return fail(res, 404, '账单不存在');
  if (!current.book_id && current.user_id !== req.user.id) return fail(res, 404, '账单不存在');
  db.prepare('DELETE FROM transactions WHERE id = ?').run(current.id);
  res.json({ ok: true });
});

// 统一解析时间区间：优先用 from/to，否则退回 year/month
function resolveBounds(query, now = new Date()) {
  if (query.from && query.to) {
    return { start: String(query.from).slice(0, 10), end: String(query.to).slice(0, 10) };
  }
  const year = Number(query.year) || now.getFullYear();
  const month = Number(query.month) || now.getMonth() + 1;
  return monthBounds(year, month);
}

// '2026-09-01' 按本地时区解析，避免 UTC 偏移把日期挪到前一天
function parseLocalDate(text) {
  const s = String(text).slice(0, 10);
  return new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
}

function daysBetween(start, end) {
  return Math.round((parseLocalDate(end) - parseLocalDate(start)) / 86400000) + 1;
}

app.get('/api/summary', authRequired, (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const { start, end } = resolveBounds(req.query, now);
  const scope = bookScope(req.user, req.query);
  const scopeSql = scope.sql;
  const scopeParams = scope.params;
  const firstDate = db.prepare(`
    SELECT MIN(occurred_at) AS first FROM transactions t WHERE ${scopeSql}
  `).get(...scopeParams)?.first || null;
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents END), 0) AS expense
    FROM transactions t
    WHERE ${scopeSql} AND occurred_at >= ? AND occurred_at < date(?, '+1 day')
  `).get(...scopeParams, start, end);
  // 同名分类可能有多个 id（历史归档留下的），按名称聚合并把 id 都收集起来，点饼图时一起筛
  const categories = db.prepare(`
    SELECT COALESCE(p.name, c.name, t.category_label, '未分类') AS category_name,
      GROUP_CONCAT(DISTINCT COALESCE(p.id, c.id)) AS category_ids,
      SUM(t.amount_cents) AS amount_cents
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    WHERE ${scopeSql} AND t.type = 'expense'
      AND t.occurred_at >= ? AND t.occurred_at < date(?, '+1 day')
    GROUP BY category_name
    ORDER BY amount_cents DESC
    LIMIT 8
  `).all(...scopeParams, start, end);
  const accounts = db.prepare(`${ACCOUNT_SQL} WHERE a.user_id = ? AND a.archived = 0 ORDER BY a.sort, a.id`).all(req.user.id);
  res.json({
    year,
    month,
    start,
    end,
    // 最早一笔流水的日期，前端选「全部」时用它当起点
    firstDate: firstDate ? String(firstDate).slice(0, 10) : null,
    income: centsToYuan(totals.income),
    expense: centsToYuan(totals.expense),
    net: centsToYuan(totals.income - totals.expense),
    categories: categories.map((row) => ({
      name: row.category_name,
      ids: row.category_ids ? row.category_ids.split(',').map(Number) : [],
      amount: centsToYuan(row.amount_cents),
    })),
    accounts: accounts.map(presentAccount),
  });
});

function eachDay(start, end) {
  const days = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    days.push(formatDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function eachMonth(start, end) {
  const months = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor <= last) {
    months.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

app.get('/api/trend', authRequired, (req, res) => {
  const now = new Date();
  const range = ['month', '3m', 'year', 'all'].includes(req.query.range) ? req.query.range : 'month';
  const scope = bookScope(req.user, req.query);
  let from;
  let to;

  if (req.query.from && req.query.to) {
    // 前端已算好区间（总览页的时间范围），直接用
    from = String(req.query.from).slice(0, 10);
    to = String(req.query.to).slice(0, 10);
  } else if (range === 'month') {
    const bounds = monthBounds(Number(req.query.year) || now.getFullYear(), Number(req.query.month) || now.getMonth() + 1);
    from = bounds.start;
    to = bounds.end;
  } else if (range === '3m') {
    from = formatDate(new Date(now.getFullYear(), now.getMonth() - 2, 1));
    to = todayString();
  } else {
    let start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    if (range === 'all') {
      const first = db.prepare(`
        SELECT MIN(occurred_at) AS first FROM transactions t
        WHERE ${scope.sql} AND type IN ('expense', 'income')
      `).get(...scope.params)?.first;
      if (first) start = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1);
    }
    from = formatDate(start);
    to = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  }

  // 跨度超过 3 个月就按月聚合，否则按天
  const unit = daysBetween(from, to) > 92 ? 'month' : 'day';
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  const keys = unit === 'month' ? eachMonth(start, end) : eachDay(start, end);
  const bucket = unit === 'month' ? "substr(occurred_at, 1, 7)" : "substr(occurred_at, 1, 10)";
  const rows = db.prepare(`
    SELECT ${bucket} AS bucket,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents END), 0) AS expense,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents END), 0) AS income
    FROM transactions t
    WHERE ${scope.sql} AND occurred_at >= ? AND occurred_at < date(?, '+1 day')
    GROUP BY bucket
  `).all(...scope.params, from, to);
  const byKey = new Map(rows.map((row) => [row.bucket, row]));
  const spansYears = unit === 'month' && keys.length > 0 && keys[0].slice(0, 4) !== keys.at(-1).slice(0, 4);
  const points = keys.map((key) => {
    const row = byKey.get(key);
    const label = unit === 'month'
      ? (spansYears ? `${key.slice(2, 4)}/${Number(key.slice(5))}` : `${Number(key.slice(5))}月`)
      : String(Number(key.slice(8)));
    return {
      key,
      label,
      expense: centsToYuan(row?.expense || 0),
      income: centsToYuan(row?.income || 0),
    };
  });
  res.json({ range, unit, from, to, points });
});

app.get('/api/duplicates', authRequired, wrap((req, res) => {
  const bookId = Number(req.query.bookId) || 0;
  if (bookId && !canSeeBook(req.user, bookId)) return fail(res, 404, '账本不存在');
  const pairs = findDuplicatePairs(req.user.id, {
    bookId,
    type: req.query.type,
    windowDays: req.query.window,
    minScore: req.query.minScore,
    minCents: req.query.minAmount ? yuanToCents(req.query.minAmount) || 0 : 0,
    from: req.query.from || null,
    to: req.query.to || null,
    sort: req.query.sort,
  });
  // 同一笔可能有三四条记录，把互相重叠的配对并成组，界面按组展示
  const ignored = new Set(listIgnores(req.user.id));
  const groups = groupDuplicates(pairs, { sort: req.query.sort })
    .filter((group) => !ignored.has(group.key));
  res.json({
    pairs,
    groups,
    ignoredCount: ignored.size,
    // 能省下的钱 = 每组留下一条，其余都算重复
    duplicateAmount: groups
      .reduce((sum, group) => sum + Number(group.amount) * (group.count - 1), 0)
      .toFixed(2),
  });
}));

// 支持一次忽略多对：body { key } 或 { keys: [...] }
app.post('/api/duplicates/ignore', authRequired, (req, res) => {
  const keys = Array.isArray(req.body?.keys)
    ? req.body.keys.map((k) => String(k || '')).filter(Boolean)
    : [String(req.body?.key || req.query.key || '')].filter(Boolean);
  if (!keys.length) return fail(res, 400, '缺少 key');
  keys.forEach((key) => ignorePair(req.user.id, key));
  res.json({ ok: true, count: keys.length });
});

app.delete('/api/duplicates/ignore', authRequired, (req, res) => {
  unignorePair(req.user.id, req.query.key || null);
  res.json({ ok: true });
});

// 批量去重：每组只留一条，删掉其余。keep=earlier 保留时间早的，keep=later 保留晚的
// 也支持直接传组方案：groups: [{ keepId, dropIds }]
app.post('/api/duplicates/resolve', authRequired, wrap((req, res) => {
  const keys = Array.isArray(req.body?.keys)
    ? req.body.keys.map((k) => String(k || '')).filter(Boolean)
    : [];
  const groupPlan = Array.isArray(req.body?.groups) ? req.body.groups : [];
  if (!keys.length && !groupPlan.length) return fail(res, 400, '请先选择要处理的重复账单');
  const keep = req.body?.keep === 'later' ? 'later' : 'earlier';
  let removed = 0;
  let skipped = 0;

  const del = db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?');
  for (const plan of groupPlan) {
    const keepId = Number(plan?.keepId) || 0;
    const dropIds = [...new Set((plan?.dropIds || []).map(Number).filter(Boolean))]
      .filter((id) => id !== keepId);
    if (!keepId || !dropIds.length) { skipped += 1; continue; }
    const marks = dropIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id FROM transactions WHERE user_id = ? AND id IN (${marks})`,
    ).all(req.user.id, ...dropIds);
    // 要删的已经不在了（别的组处理过），只删还剩下的
    if (!rows.length) { skipped += 1; continue; }
    for (const row of rows) {
      del.run(row.id, req.user.id);
      removed += 1;
    }
  }

  for (const key of keys) {
    const [aId, bId] = String(key).split('-').map(Number);
    if (!aId || !bId) { skipped += 1; continue; }
    const rows = db.prepare(
      'SELECT id, occurred_at FROM transactions WHERE user_id = ? AND id IN (?, ?)',
    ).all(req.user.id, aId, bId);
    // 其中一条已经在别的配对里被删掉了，跳过
    if (rows.length < 2) { skipped += 1; continue; }
    const sorted = [...rows].sort((x, y) => (
      String(x.occurred_at).localeCompare(String(y.occurred_at)) || x.id - y.id
    ));
    const drop = keep === 'later' ? sorted[0] : sorted[sorted.length - 1];
    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(drop.id, req.user.id);
    removed += 1;
  }
  res.json({ ok: true, removed, skipped });
}));

app.get('/api/calendar', authRequired, wrap((req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const { start, end } = monthBounds(year, month);
  const scope = bookScope(req.user, req.query);
  const rows = db.prepare(`
    SELECT substr(occurred_at, 1, 10) AS day, type, SUM(amount_cents) AS amount_cents, COUNT(*) AS n
    FROM transactions t
    WHERE ${scope.sql} AND occurred_at >= ? AND occurred_at < date(?, '+1 day')
    GROUP BY day, type
  `).all(...scope.params, start, end);
  const days = {};
  for (const row of rows) {
    days[row.day] ||= { income: 0, expense: 0, count: 0, planned: [] };
    if (row.type === 'income') days[row.day].income += row.amount_cents;
    if (row.type === 'expense') days[row.day].expense += row.amount_cents;
    days[row.day].count += row.n;
  }
  const today = todayString();
  const ruleIds = ruleBookIds(req.user, req.query.bookId);
  const ruleMarks = ruleIds.length ? ruleIds.map(() => '?').join(',') : '0';
  const rules = db.prepare(
    `SELECT * FROM recurring_rules WHERE user_id = ? AND paused = 0 AND book_id IN (${ruleMarks})`,
  ).all(req.user.id, ...ruleIds);
  for (const row of rules) {
    const rule = loadRule(row);
    for (const date of pendingInMonth(rule, start, end, today)) {
      days[date] ||= { income: 0, expense: 0, count: 0, planned: [] };
      days[date].planned.push({
        id: rule.id,
        type: rule.type,
        amount: centsToYuan(rule.amountCents),
        payee: rule.payee,
        note: rule.note,
      });
    }
  }
  const calendar = Object.entries(days).map(([day, value]) => ({
    day,
    income: centsToYuan(value.income),
    expense: centsToYuan(value.expense),
    count: value.count,
    planned: value.planned,
  }));
  res.json({ year, month, days: calendar });
}));

// 定期账单也挂在某个账本上：不传就用个人账本，传了必须有记账权限
function ruleBook(user, bookId) {
  const book = bookId ? canSeeBook(user, Number(bookId)) : ensurePersonalBook(user.id);
  if (!book) throw Object.assign(new Error('账本不存在'), { status: 404 });
  if (!canWriteBook(user, book)) throw Object.assign(new Error('没有这个账本的记账权限'), { status: 403 });
  return book;
}

function ruleBookIds(user, bookId) {
  const asked = Number(bookId) || 0;
  if (asked) {
    if (!canSeeBook(user, asked)) throw Object.assign(new Error('账本不存在'), { status: 404 });
    return [asked];
  }
  return visibleBookIds(user.id);
}

app.get('/api/recurring', authRequired, wrap((req, res) => {
  const asked = Number(req.query.bookId) || 0;
  const ids = ruleBookIds(req.user, asked);
  const marks = ids.length ? ids.map(() => '?').join(',') : '0';
  const rows = db.prepare(
    `SELECT * FROM recurring_rules WHERE user_id = ? AND book_id IN (${marks}) ORDER BY paused, next_run, id`,
  ).all(req.user.id, ...ids);
  res.json({ rules: rows.map(presentRule) });
}));

app.post('/api/recurring', authRequired, wrap((req, res) => {
  const book = ruleBook(req.user, req.body.bookId);
  const rule = { ...ruleFromBody(req.user.id, req.body), bookId: book.id };
  const nextRun = initialNextRun(rule);
  const created = db.prepare(`
    INSERT INTO recurring_rules (
      user_id, book_id, type, amount_cents, account_id, to_account_id, category_id, payee, note,
      frequency, interval_days, weekdays, month_day, year_month, year_day,
      start_date, end_date, time, next_run, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.userId, rule.bookId, rule.type, rule.amountCents, rule.accountId, rule.toAccountId, rule.categoryId,
    rule.payee || null, rule.note || null, rule.frequency, rule.intervalDays,
    JSON.stringify(rule.weekdays), rule.monthDay, rule.yearMonth, rule.yearDay,
    rule.startDate, rule.endDate, rule.time, nextRun, new Date().toISOString(),
  );
  const stored = loadRule(db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(Number(created.lastInsertRowid)));
  generateRule(stored, { through: todayString() });
  res.json({ rule: presentRule(db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(stored.id)) });
}));

app.patch('/api/recurring/:id', authRequired, wrap((req, res) => {
  const current = db.prepare('SELECT * FROM recurring_rules WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!current) return fail(res, 404, '定期账单不存在');
  const ownedBook = current.book_id ? canSeeBook(req.user, current.book_id) : null;
  if (current.book_id && (!ownedBook || !canWriteBook(req.user, ownedBook))) return fail(res, 403, '没有这个账本的记账权限');
  if (req.body.paused != null && Object.keys(req.body).length === 1) {
    db.prepare('UPDATE recurring_rules SET paused = ? WHERE id = ?').run(req.body.paused ? 1 : 0, current.id);
    return res.json({ rule: presentRule(db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(current.id)) });
  }
  const rule = ruleFromBody(req.user.id, {
    type: req.body.type ?? current.type,
    amount: req.body.amount ?? centsToYuan(current.amount_cents),
    accountId: req.body.accountId ?? current.account_id,
    toAccountId: req.body.toAccountId ?? current.to_account_id,
    categoryId: req.body.categoryId ?? current.category_id,
    payee: req.body.payee ?? current.payee,
    note: req.body.note ?? current.note,
    frequency: req.body.frequency ?? current.frequency,
    intervalDays: req.body.intervalDays ?? current.interval_days,
    weekdays: req.body.weekdays ?? (current.weekdays ? JSON.parse(current.weekdays) : []),
    monthDay: req.body.monthDay ?? current.month_day,
    yearMonth: req.body.yearMonth ?? current.year_month,
    yearDay: req.body.yearDay ?? current.year_day,
    startDate: req.body.startDate ?? current.start_date,
    endDate: req.body.endDate ?? current.end_date,
    time: req.body.time ?? current.time,
  });
  const nextRun = initialNextRun(rule);
  db.prepare(`
    UPDATE recurring_rules SET
      type = ?, amount_cents = ?, account_id = ?, to_account_id = ?, category_id = ?,
      payee = ?, note = ?, frequency = ?, interval_days = ?, weekdays = ?, month_day = ?,
      year_month = ?, year_day = ?, start_date = ?, end_date = ?, time = ?, next_run = ?, paused = ?
    WHERE id = ?
  `).run(
    rule.type, rule.amountCents, rule.accountId, rule.toAccountId, rule.categoryId,
    rule.payee || null, rule.note || null, rule.frequency, rule.intervalDays, JSON.stringify(rule.weekdays),
    rule.monthDay, rule.yearMonth, rule.yearDay, rule.startDate, rule.endDate, rule.time, nextRun,
    req.body.paused != null ? (req.body.paused ? 1 : 0) : current.paused, current.id,
  );
  res.json({ rule: presentRule(db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(current.id)) });
}));

app.delete('/api/recurring/:id', authRequired, wrap((req, res) => {
  const current = db.prepare('SELECT * FROM recurring_rules WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!current) return fail(res, 404, '定期账单不存在');
  const ownedBook = current.book_id ? canSeeBook(req.user, current.book_id) : null;
  if (current.book_id && (!ownedBook || !canWriteBook(req.user, ownedBook))) return fail(res, 403, '没有这个账本的记账权限');
  db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(current.id);
  res.json({ ok: true });
}));

function previewRow(row) {
  return {
    occurredAt: row.occurredAt,
    type: row.type,
    amount: row.amountCents == null ? '' : centsToYuan(row.amountCents),
    amountCents: row.amountCents,
    categoryName: row.categoryName || '',
    subcategoryName: row.subcategoryName || '',
    accountName: row.accountName || '',
    toAccountName: row.toAccountName || '',
    payee: row.payee || '',
    note: row.note || '',
    externalId: row.externalId || '',
    skipReason: row.skipReason,
    incoming: !!row.incoming,
  };
}

function decodeUploadName(name) {
  const raw = name || '账单';
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD') || /[\u0080-\u009f]/.test(decoded)) return raw;
  if (decoded !== raw && /[\u4e00-\u9fff]/.test(decoded)) return decoded;
  return raw;
}

async function parseUpload(file, source, mapping) {
  const filename = decodeUploadName(file.originalname);
  try {
    const parsed = await parseFile(file.buffer, filename, source, mapping);
    if (parsed.needsMapping) {
      return {
        filename,
        needsMapping: true,
        source: parsed.source,
        headers: parsed.headers,
        suggested: parsed.suggested,
        samples: parsed.samples,
        rows: [],
        total: 0,
        ready: 0,
        skipped: 0,
      };
    }
    const rows = parsed.rows.map((row) => ({ ...previewRow(row), source: parsed.source, filename }));
    return {
      filename,
      needsMapping: false,
      source: parsed.source,
      total: rows.length,
      ready: rows.filter((row) => !row.skipReason).length,
      skipped: rows.filter((row) => row.skipReason).length,
      rows,
    };
  } catch (err) {
    return {
      filename,
      needsMapping: false,
      error: err.message || '解析失败',
      rows: [],
      total: 0,
      ready: 0,
      skipped: 0,
    };
  }
}

// 预览时告诉前端真正会新建哪些账户/分类：按统一归类算，不再按账单原名一个一个建。
function previewNewNames(userId, rows) {
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

const uploadImports = upload.fields([
  { name: 'files', maxCount: 30 },
  { name: 'file', maxCount: 1 },
]);

app.post('/api/import/preview', authRequired, uploadImports, wrap(async (req, res) => {
  const files = [...(req.files?.files || []), ...(req.files?.file || [])];
  if (!files.length) return fail(res, 400, '请选择账单文件');
  let mapping = null;
  if (req.body.mapping) {
    try { mapping = JSON.parse(req.body.mapping); }
    catch { return fail(res, 400, '字段映射格式不正确'); }
  }
  const parsedFiles = await Promise.all(files.map((file) => parseUpload(file, req.body.source || 'auto', mapping)));
  const rows = parsedFiles.flatMap((file) => file.rows || []);
  res.json({
    files: parsedFiles,
    needsMapping: parsedFiles.some((file) => file.needsMapping),
    ...previewNewNames(req.user.id, rows),
    total: rows.length,
    ready: rows.filter((row) => !row.skipReason).length,
    skipped: rows.filter((row) => row.skipReason).length,
  });
}));

app.post('/api/import/commit', authRequired, wrap((req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const source = String(req.body.source || 'custom');
  const bookId = req.body.bookId ? Number(req.body.bookId) : null;
  if (bookId) {
    const book = canSeeBook(req.user, bookId);
    if (!book || !canWriteBook(req.user, book)) return fail(res, 403, '没有当前账本的导入权限');
  }
  if (!rows.length) return fail(res, 400, '没有可导入的账单');
  let inserted = 0;
  let duplicated = 0;
  let failed = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (row.skipReason) continue;
      try {
        const info = insertTransaction(req.user, { ...row, bookId }, row.source || source, row.externalId || null);
        if (info.changes) inserted += 1;
        else duplicated += 1;
      } catch {
        failed += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ inserted, duplicated, failed });
}));

const publicDir = path.join(process.cwd(), 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ message: err.message || '服务器错误' });
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => {
  startScheduler();
  console.log(`轻账单服务已启动 http://127.0.0.1:${port}`);
});

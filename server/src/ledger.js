import { db } from './db.js';
import { kindFromName } from './seed.js';
import { normalizeAccountName, resolveCategoryPath } from './taxonomy.js';
import { centsToYuan } from './money.js';

export function accountOwned(userId, id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ? AND archived = 0').get(id, userId);
}

export function categoryOwned(userId, id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ? AND archived = 0').get(id, userId);
}

// 账户归并到哪个统一账户，凡是要落账、展示的地方都先过一遍。
export function canonicalAccount(row) {
  if (!row || !row.merged_into) return row;
  const parent = db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.merged_into);
  return parent || row;
}

export function resolveAccount(userId, name) {
  const trimmed = normalizeAccountName(name);
  if (!trimmed || trimmed === '/') return null;
  const found = db.prepare('SELECT * FROM accounts WHERE user_id = ? AND name = ?').get(userId, trimmed);
  if (found) return canonicalAccount(found);
  const alias = db.prepare(
    'SELECT a.* FROM account_aliases x JOIN accounts a ON a.id = x.account_id WHERE x.user_id = ? AND x.alias = ?',
  ).get(userId, trimmed);
  if (alias) return canonicalAccount(alias);
  const digits = trimmed.match(/(\d{4})\s*\)?$/)?.[1];
  if (!digits) return null;
  const rows = db.prepare(
    'SELECT * FROM accounts WHERE user_id = ? AND archived = 0 AND name LIKE ?',
  ).all(userId, `%${digits}%`);
  if (rows.length === 1) return canonicalAccount(rows[0]);
  const byAlias = db.prepare(
    'SELECT a.* FROM account_aliases x JOIN accounts a ON a.id = x.account_id WHERE x.user_id = ? AND x.alias LIKE ?',
  ).all(userId, `%${digits}%`);
  if (byAlias.length === 1) return canonicalAccount(byAlias[0]);
  return null;
}

export function ensureAccount(userId, name) {
  const trimmed = normalizeAccountName(name);
  if (!trimmed) {
    const fallback = db.prepare(
      'SELECT * FROM accounts WHERE user_id = ? AND archived = 0 AND merged_into IS NULL ORDER BY sort, id LIMIT 1',
    ).get(userId);
    if (!fallback) throw new Error('请先创建账户');
    return fallback;
  }
  const found = resolveAccount(userId, trimmed);
  if (found) {
    // 已归并出去的账户保持归档，别因为它又被提到就冒出来。
    if (found.archived && !found.merged_into) {
      db.prepare('UPDATE accounts SET archived = 0 WHERE id = ?').run(found.id);
    }
    return found;
  }
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM accounts WHERE user_id = ?').get(userId).n;
  const created = db.prepare(
    'INSERT INTO accounts (user_id, name, kind, sort) VALUES (?, ?, ?, ?)',
  ).run(userId, trimmed, kindFromName(trimmed), sort);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(created.lastInsertRowid));
}

function categoryByName(userId, kind, name) {
  return db.prepare('SELECT * FROM categories WHERE user_id = ? AND kind = ? AND name = ?').get(userId, kind, name);
}

// 分类别名优先：账单里的外部分类名直接落到统一分类上。
export function resolveCategoryAlias(userId, kind, name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const row = db.prepare(
    'SELECT c.* FROM category_aliases x JOIN categories c ON c.id = x.category_id WHERE x.user_id = ? AND x.kind = ? AND x.alias = ?',
  ).get(userId, kind, raw);
  if (row) return row;
  return null;
}

function ensureTreeCategory(userId, kind, parentName, childName) {
  let parentId = null;
  if (parentName) {
    let parentRow = db.prepare(
      'SELECT * FROM categories WHERE user_id = ? AND kind = ? AND name = ? AND parent_id IS NULL',
    ).get(userId, kind, parentName);
    if (!parentRow) {
      const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories WHERE user_id = ? AND parent_id IS NULL').get(userId).n;
      const created = db.prepare(
        'INSERT INTO categories (user_id, name, parent_id, kind, sort) VALUES (?, ?, NULL, ?, ?)',
      ).run(userId, parentName, kind, sort);
      parentRow = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(created.lastInsertRowid));
    }
    parentId = parentRow.id;
  }
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories WHERE user_id = ?').get(userId).n;
  const created = db.prepare(
    'INSERT INTO categories (user_id, name, parent_id, kind, sort) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, childName, parentId, kind, sort);
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(created.lastInsertRowid));
}

export function ensureCategory(userId, kind, parentName, childName) {
  const parent = (parentName || '').trim();
  const child = (childName || '').trim();
  const leaf = child || parent;
  const find = db.prepare('SELECT * FROM categories WHERE user_id = ? AND kind = ? AND name = ?');
  if (!leaf) {
    const other = find.get(userId, kind, '其他');
    if (other) return other;
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories WHERE user_id = ? AND parent_id IS NULL').get(userId).n;
    const created = db.prepare(
      'INSERT INTO categories (user_id, name, parent_id, kind, sort) VALUES (?, ?, NULL, ?, ?)',
    ).run(userId, '其他', kind, sort);
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(created.lastInsertRowid));
  }
  // 先按别名把外部分类名换算成统一分类
  const path = resolveCategoryPath(leaf, kind);
  if (path) {
    const [topName, subName] = path;
    const top = find.get(userId, kind, topName) || ensureTreeCategory(userId, kind, null, topName);
    if (!subName) return top;
    return find.get(userId, kind, subName) || ensureTreeCategory(userId, kind, topName, subName);
  }
  const aliased = resolveCategoryAlias(userId, kind, leaf);
  if (aliased) return aliased;
  const found = find.get(userId, kind, leaf);
  if (found) return found;
  // 认不出来的分类统一落到「其他」，不再新建，避免越导越乱。
  const fallback = find.get(userId, kind, '其他') || ensureTreeCategory(userId, kind, null, '其他');
  db.prepare(
    'INSERT OR REPLACE INTO category_aliases (user_id, kind, alias, category_id) VALUES (?, ?, ?, ?)',
  ).run(userId, kind, leaf, fallback.id);
  return fallback;
}

// 把 source 归并到 target：流水、初始余额一起搬过去，source 归档并记住旧名。
export function mergeAccount(userId, sourceId, targetId) {
  const source = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(Number(sourceId), userId);
  const target = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(Number(targetId), userId);
  if (!source || !target || source.id === target.id) throw new Error('请选择两个不同的账户');
  if (source.merged_into === target.id) return target;
  if (target.merged_into) return mergeAccount(userId, sourceId, target.merged_into);
  // 如果 source 是别人的主账户，先把挂在它名下的账户接过来
  db.prepare('UPDATE accounts SET merged_into = ? WHERE merged_into = ?').run(target.id, source.id);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE transactions SET account_id = ? WHERE user_id = ? AND account_id = ?').run(target.id, userId, source.id);
    db.prepare('UPDATE transactions SET to_account_id = ? WHERE user_id = ? AND to_account_id = ?').run(target.id, userId, source.id);
    db.prepare('UPDATE recurring_rules SET account_id = ? WHERE user_id = ? AND account_id = ?').run(target.id, userId, source.id);
    db.prepare('UPDATE recurring_rules SET to_account_id = ? WHERE user_id = ? AND to_account_id = ?').run(target.id, userId, source.id);
    db.prepare('UPDATE accounts SET initial_cents = initial_cents + ? WHERE id = ?').run(source.initial_cents, target.id);
    db.prepare('UPDATE accounts SET merged_into = ?, archived = 1, initial_cents = 0 WHERE id = ?').run(target.id, source.id);
    for (const alias of new Set([source.name, normalizeAccountName(source.name)])) {
      if (!alias || alias === target.name) continue;
      db.prepare(
        'INSERT OR REPLACE INTO account_aliases (user_id, alias, account_id) VALUES (?, ?, ?)',
      ).run(userId, alias, target.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return target;
}

// 解除归并：账户重新独立，已经并进去的流水留在原主账户。
export function unmergeAccount(userId, accountId) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(Number(accountId), userId);
  if (!row || !row.merged_into) throw new Error('该账户没有归并到别的账户');
  db.prepare('UPDATE accounts SET merged_into = NULL, archived = 0 WHERE id = ?').run(row.id);
  db.prepare('DELETE FROM account_aliases WHERE user_id = ? AND account_id = ? AND alias = ?').run(userId, row.merged_into, row.name);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id);
}

export function saveAccountAlias(userId, alias, accountId) {
  const name = String(alias || '').trim();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(Number(accountId), userId);
  if (!name || !account) throw new Error('请填写别名并选择账户');
  db.prepare(
    'INSERT OR REPLACE INTO account_aliases (user_id, alias, account_id) VALUES (?, ?, ?)',
  ).run(userId, name, canonicalAccount(account).id);
}

export function deleteAccountAlias(userId, id) {
  db.prepare('DELETE FROM account_aliases WHERE id = ? AND user_id = ?').run(Number(id), userId);
}

export function listAccountAliases(userId) {
  return db.prepare(`
    SELECT x.id, x.alias, x.account_id, a.name AS account_name
    FROM account_aliases x JOIN accounts a ON a.id = x.account_id
    WHERE x.user_id = ? ORDER BY x.alias
  `).all(userId);
}

const TX_SELECT = `
  SELECT t.*,
    c.name AS category_name,
    p.name AS parent_name,
    a.name AS account_name,
    b.name AS to_account_name
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN categories p ON p.id = c.parent_id
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN accounts b ON b.id = t.to_account_id
`;

export function presentTransaction(row, images = null) {
  const category = row.parent_name
    ? `${row.parent_name} / ${row.category_name}`
    : (row.category_name || row.category_label || '');
  return {
    id: row.id,
    bookId: row.book_id ?? null,
    type: row.type,
    amount: centsToYuan(row.amount_cents),
    accountId: row.account_id,
    accountName: row.account_name,
    toAccountId: row.to_account_id,
    toAccountName: row.to_account_name,
    categoryId: row.category_id,
    categoryName: category,
    categoryLabel: row.category_label || '',
    memberName: row.member_name || '',
    occurredAt: row.occurred_at,
    payee: row.payee || '',
    note: row.note || '',
    source: row.source,
    images: images || [],
  };
}

export function selectTransactions() {
  return TX_SELECT;
}

export function presentAccount(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    initial: centsToYuan(row.initial_cents),
    balance: centsToYuan(row.balance_cents),
    archived: !!row.archived,
    mergedInto: row.merged_into ? Number(row.merged_into) : null,
  };
}

// 余额把归并进来的账户一起算上：主账户 = 自己 + 所有归属它的账户。
const GROUP_MATCH = '(base.id = a.id OR base.merged_into = a.id)';

export const ACCOUNT_SQL = `
  SELECT a.*,
    (SELECT COALESCE(SUM(base.initial_cents), 0) FROM accounts base WHERE ${GROUP_MATCH})
    + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t JOIN accounts base ON base.id = t.account_id WHERE ${GROUP_MATCH} AND t.type = 'income'), 0)
    - COALESCE((SELECT SUM(t.amount_cents) FROM transactions t JOIN accounts base ON base.id = t.account_id WHERE ${GROUP_MATCH} AND t.type = 'expense'), 0)
    - COALESCE((SELECT SUM(t.amount_cents) FROM transactions t JOIN accounts base ON base.id = t.account_id WHERE ${GROUP_MATCH} AND t.type = 'transfer'), 0)
    + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t JOIN accounts base ON base.id = t.to_account_id WHERE ${GROUP_MATCH} AND t.type = 'transfer'), 0)
    AS balance_cents
  FROM accounts a
`;

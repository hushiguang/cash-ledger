// 一次性把历史数据归并到统一分类体系和统一账户。
// 运行：cd server && node src/migrate-taxonomy.js
// 会更新 categories / accounts / transactions，并把旧条目归档（可回滚，不删除）。
import { db } from './db.js';
import { accountKindOf, CATEGORY_TREE, normalizeAccountName, resolveCategoryPath } from './taxonomy.js';

function findCategory(userId, kind, name) {
  return db.prepare('SELECT * FROM categories WHERE user_id = ? AND kind = ? AND name = ?').get(userId, kind, name);
}

function createCategory(userId, kind, name, parentId) {
  const sort = db.prepare(
    'SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories WHERE user_id = ?',
  ).get(userId).n;
  const created = db.prepare(
    'INSERT INTO categories (user_id, name, parent_id, kind, sort) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, name, parentId, kind, sort);
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(created.lastInsertRowid));
}

function migrateCategories(userId) {
  const old = db.prepare('SELECT * FROM categories WHERE user_id = ? ORDER BY id').all(userId);
  // 先给旧分类改名，把名字空间让出来，避免和新分类树撞名。
  for (const row of old) {
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(`${row.name}·旧${row.id}`, row.id);
  }

  // 按统一分类树重建一套
  for (const kind of ['expense', 'income']) {
    CATEGORY_TREE[kind].forEach(([top, children], i) => {
      const parent = createCategory(userId, kind, top, null);
      db.prepare('UPDATE categories SET sort = ? WHERE id = ?').run(i, parent.id);
      children.forEach((child, j) => {
        const leaf = createCategory(userId, kind, child, parent.id);
        db.prepare('UPDATE categories SET sort = ? WHERE id = ?').run(j, leaf.id);
      });
    });
  }

  let moved = 0;
  for (const row of old) {
    const path = resolveCategoryPath(row.name, row.kind) || ['其他'];
    const [topName, subName] = path;
    let top = findCategory(userId, row.kind, topName) || createCategory(userId, row.kind, topName, null);
    let target = top;
    if (subName) {
      const leaf = findCategory(userId, row.kind, subName);
      target = leaf || createCategory(userId, row.kind, subName, top.id);
    }
    const info = db.prepare(
      'UPDATE transactions SET category_id = ? WHERE user_id = ? AND category_id = ?',
    ).run(target.id, userId, row.id);
    moved += info.changes;
    if (row.name !== target.name) {
      db.prepare(
        'INSERT OR REPLACE INTO category_aliases (user_id, kind, alias, category_id) VALUES (?, ?, ?, ?)',
      ).run(userId, row.kind, row.name, target.id);
    }
    db.prepare('UPDATE categories SET archived = 1 WHERE id = ?').run(row.id);
  }
  return moved;
}

function txCount(column, id) {
  return db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${column} = ?`).get(id).n;
}

function migrateAccounts(userId) {
  const rows = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY sort, id').all(userId);
  const normalized = new Map();
  for (const row of rows) {
    normalized.set(row.id, normalizeAccountName(row.name) || row.name);
  }

  // 按统一账户名分组，组内选出主账户
  const groups = new Map();
  for (const row of rows) {
    const key = normalized.get(row.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const plan = [];
  for (const [name, members] of groups) {
    const primary = members.find((m) => m.name === name)
      || [...members].sort((a, b) => txCount('account_id', b.id) - txCount('account_id', a.id))[0];
    plan.push({ name, primary, members: members.filter((m) => m.id !== primary.id) });
  }

  // 先把非主账户改名，腾出名字空间
  for (const { members } of plan) {
    for (const row of members) {
      db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(`${row.name}·旧${row.id}`, row.id);
    }
  }
  for (const { name, primary } of plan) {
    if (primary.name !== name) {
      db.prepare('UPDATE accounts SET name = ?, kind = ? WHERE id = ?').run(name, accountKindOf(name), primary.id);
    }
  }

  let moved = 0;
  let merged = 0;
  for (const { name, primary, members } of plan) {
    for (const row of members) {
      moved += db.prepare(
        'UPDATE transactions SET account_id = ? WHERE user_id = ? AND account_id = ?',
      ).run(primary.id, userId, row.id).changes;
      moved += db.prepare(
        'UPDATE transactions SET to_account_id = ? WHERE user_id = ? AND to_account_id = ?',
      ).run(primary.id, userId, row.id).changes;
      db.prepare(
        'UPDATE recurring_rules SET account_id = ? WHERE user_id = ? AND account_id = ?',
      ).run(primary.id, userId, row.id);
      db.prepare(
        'UPDATE recurring_rules SET to_account_id = ? WHERE user_id = ? AND to_account_id = ?',
      ).run(primary.id, userId, row.id);
      db.prepare(
        'UPDATE accounts SET initial_cents = initial_cents + ? WHERE id = ?',
      ).run(row.initial_cents, primary.id);
      db.prepare(
        'UPDATE accounts SET merged_into = ?, archived = 1, initial_cents = 0 WHERE id = ?',
      ).run(primary.id, row.id);
      // 记住旧名字，下次导入同名账单直接落到统一账户
      for (const alias of new Set([row.name, normalizeAccountName(row.name)])) {
        if (!alias || alias === name) continue;
        db.prepare(
          'INSERT OR REPLACE INTO account_aliases (user_id, alias, account_id) VALUES (?, ?, ?)',
        ).run(userId, alias, primary.id);
      }
      merged += 1;
    }
  }
  return { moved, merged, selfTransfer: 0 };
}

// 归并后「自己的账户转自己」已经没有意义，直接删掉：
// 这类流水原本就是一进一出，删除前后账户余额不变。
function dropSelfTransfers() {
  return db.prepare(
    "DELETE FROM transactions WHERE type = 'transfer' AND to_account_id = account_id AND to_account_id IS NOT NULL",
  ).run().changes;
}

const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
db.exec('BEGIN');
try {
  for (const user of users) {
    const catMoved = migrateCategories(user.id);
    const acc = migrateAccounts(user.id);
    console.log(
      `${user.username}: 分类重映射 ${catMoved} 笔；账户归并 ${acc.merged} 个、迁移流水 ${acc.moved} 笔`,
    );
  }
  const dropped = dropSelfTransfers();
  if (dropped) console.log(`清理自己转自己的无效流水 ${dropped} 笔`);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('迁移失败，已回滚：', err);
  process.exitCode = 1;
}

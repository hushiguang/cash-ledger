#!/usr/bin/env node
// 删除用户及其全部数据（账单、账户、分类、账本、定期规则、别名……）。
// 删除前会自动备份数据库，删错了把备份改回 ledger.db 即可。
//
//   node --experimental-sqlite server/scripts/remove-user.mjs Leo testuser
//   node --experimental-sqlite server/scripts/remove-user.mjs --dry-run Leo
//   DATABASE_PATH=/data/ledger.db node --experimental-sqlite server/scripts/remove-user.mjs Leo

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const names = args.filter((a) => !a.startsWith('--'));

if (!names.length) {
  console.error('用法：remove-user.mjs [--dry-run] <用户名或id> [...]');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'ledger.db');
if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

const findUser = db.prepare('SELECT * FROM users WHERE username = ? OR id = ?');
const users = [];
for (const name of names) {
  const row = findUser.get(name, Number(name) || -1);
  if (!row) {
    console.error(`用户不存在：${name}`);
    process.exit(1);
  }
  users.push(row);
}

function count(sql, id) {
  return db.prepare(sql).get(id).c;
}

console.log(`数据库：${dbPath}${dryRun ? '（演练，不会改动）' : ''}`);
for (const user of users) {
  console.log(
    `  #${user.id} ${user.username}：账单 ${count('SELECT COUNT(*) c FROM transactions WHERE user_id = ?', user.id)}`
    + `，账户 ${count('SELECT COUNT(*) c FROM accounts WHERE user_id = ?', user.id)}`
    + `，分类 ${count('SELECT COUNT(*) c FROM categories WHERE user_id = ?', user.id)}`
    + `，账本 ${count('SELECT COUNT(*) c FROM books WHERE owner_id = ?', user.id)}`,
  );
}
if (dryRun) process.exit(0);

// 备份
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${dbPath}.bak-${stamp}`;
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`已备份：${backup}`);

const del = (sql) => db.prepare(sql);
const txImages = del('DELETE FROM transaction_images WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)');
const byUser = {
  transactions: del('DELETE FROM transactions WHERE user_id = ?'),
  recurring_rules: del('DELETE FROM recurring_rules WHERE user_id = ?'),
  import_drafts: del('DELETE FROM import_drafts WHERE user_id = ?'),
  import_templates: del('DELETE FROM import_templates WHERE user_id = ?'),
  account_aliases: del('DELETE FROM account_aliases WHERE user_id = ?'),
  category_aliases: del('DELETE FROM category_aliases WHERE user_id = ?'),
  duplicate_ignores: del('DELETE FROM duplicate_ignores WHERE user_id = ?'),
};
const membersOwn = del('DELETE FROM book_members WHERE book_id IN (SELECT id FROM books WHERE owner_id = ?)');
const membersJoined = del('DELETE FROM book_members WHERE user_id = ?');
const books = del('DELETE FROM books WHERE owner_id = ?');
const accounts = del('DELETE FROM accounts WHERE user_id = ?');
const categories = del('DELETE FROM categories WHERE user_id = ?');
const userRow = del('DELETE FROM users WHERE id = ?');

db.exec('BEGIN');
try {
  for (const user of users) {
    txImages.run(user.id);
    for (const stmt of Object.values(byUser)) stmt.run(user.id);
    membersOwn.run(user.id);
    membersJoined.run(user.id);
    books.run(user.id);
    accounts.run(user.id);
    categories.run(user.id);
    userRow.run(user.id);
    console.log(`已删除：#${user.id} ${user.username}`);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('删除失败，已回滚：', err.message);
  process.exit(1);
}

const left = db.prepare('SELECT id, username FROM users').all();
console.log('剩余用户：', JSON.stringify(left));
db.close();

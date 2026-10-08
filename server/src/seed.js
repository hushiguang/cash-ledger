import { db } from './db.js';
import { ensurePersonalBook } from './books.js';
import { accountKindOf, CATEGORY_TREE } from './taxonomy.js';

const ACCOUNTS = [
  ['现金', 'cash'],
  ['微信零钱', 'wechat'],
  ['支付宝余额', 'alipay'],
  ['余额宝', 'alipay'],
  ['花呗', 'alipay'],
  ['银行卡', 'bank'],
  ['京东小金库', 'jd'],
];

export function seedUser(userId) {
  const insertAccount = db.prepare(
    'INSERT INTO accounts (user_id, name, kind, sort) VALUES (?, ?, ?, ?)',
  );
  ACCOUNTS.forEach(([name, kind], i) => insertAccount.run(userId, name, kind, i));

  const insertCategory = db.prepare(
    'INSERT INTO categories (user_id, name, parent_id, kind, sort) VALUES (?, ?, ?, ?, ?)',
  );
  for (const kind of ['expense', 'income']) {
    CATEGORY_TREE[kind].forEach(([name, children], i) => {
      const parent = insertCategory.run(userId, name, null, kind, i);
      const parentId = Number(parent.lastInsertRowid);
      children.forEach((child, j) => insertCategory.run(userId, child, parentId, kind, j));
    });
  }
  ensurePersonalBook(userId);
}

export function kindFromName(name) {
  return accountKindOf(name);
}

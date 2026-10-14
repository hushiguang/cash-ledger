// 一次性迁移的种子：把改造前写死在 taxonomy.js 里的账户别名映射（账单里的叫法 → 统一账户），
// 导入到按用户存储的 account_aliases 表。既可以直接运行（cd server && node scripts/migrate-account-aliases.js），
// 也会被服务端在启动时自动调用。幂等：同一用户已有的同名 alias 不会重复插入，也不会覆盖用户的自定义。
// 注意：ALIASES 数组只是“过渡桥”，首次跑完、确认无误后，可把它清空；之后别名全在数据库里，由页面维护。
import { db } from '../src/db.js';
import { fileURLToPath } from 'node:url';
import { accountKindOf } from '../src/taxonomy.js';

// [账单里的叫法, 统一账户名]
const ALIASES = [
  ['零钱', '微信零钱'],
  ['微信', '微信零钱'],
  ['微信支付', '微信零钱'],
  ['余额', '支付宝余额'],
  ['账户余额', '支付宝余额'],
  ['支付宝', '支付宝余额'],
  ['京东', '京东小金库'],
  ['京东支付', '京东小金库'],
  ['小金库零用钱', '京东小金库'],
  ['中国工商银行', '工商银行储蓄卡(2587)'],
  ['工商银行', '工商银行储蓄卡(2587)'],
  ['中国建设银行', '建设银行储蓄卡(2444)'],
  ['建设银行', '建设银行储蓄卡(2444)'],
  ['中国工商银行储蓄卡', '工商银行储蓄卡(2587)'],
  ['邯郸银行', '邯郸银行储蓄卡(3913)'],
  ['招商银行储蓄卡', '招商银行储蓄卡(5568)'],
  ['招商银行', '招商银行储蓄卡(5568)'],
  ['招商银行(5568)', '招商银行储蓄卡(5568)'],
  ['招商银行信用卡', '招商银行信用卡(3116)'],
  ['招商银行信用卡分期(3116) 3期', '招商银行信用卡(3116)'],
  ['建设银行储蓄卡', '建设银行储蓄卡(2444)'],
  ['工商银行储蓄卡', '工商银行储蓄卡(2587)'],
  ['工商银行储蓄卡(5945)', '工商银行储蓄卡(5945)'],
  ['邯郸银行储蓄卡(3913)', '邯郸银行储蓄卡(3913)'],
  ['网商银行储蓄卡(9869)', '网商银行储蓄卡(9869)'],
  ['中信银行信用卡(6376)', '中信银行信用卡(6376)'],
  ['花呗分期', '花呗'],
];

function ensureAccount(userId, name) {
  const existing = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND name = ?').get(userId, name);
  if (existing) return existing.id;
  const info = db.prepare(
    'INSERT INTO accounts (user_id, name, kind, initial_cents, sort, archived, created_at) VALUES (?, ?, ?, 0, 0, 0, ?)',
  ).run(userId, name, accountKindOf(name), new Date().toISOString());
  return Number(info.lastInsertRowid);
}

// 幂等：只补用户还没有的 alias；已存在的（无论来源）一律跳过，不覆盖自定义。
export function seedAccountAliases() {
  const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
  if (!users.length) return { users: 0, added: 0 };
  let added = 0;
  for (const user of users) {
    for (const [alias, target] of ALIASES) {
      const dup = db.prepare('SELECT 1 FROM account_aliases WHERE user_id = ? AND alias = ?').get(user.id, alias);
      if (dup) continue;
      const targetId = ensureAccount(user.id, target);
      db.prepare('INSERT OR IGNORE INTO account_aliases (user_id, alias, account_id) VALUES (?, ?, ?)')
        .run(user.id, alias, targetId);
      added += 1;
    }
  }
  return { users: users.length, added };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = seedAccountAliases();
  if (r.users === 0) {
    console.log('没有用户，跳过。');
  } else {
    console.log(`账户别名种子导入完成：为 ${r.users} 个用户新增 ${r.added} 条（可在「账户 → 账单里的其它叫法」页面维护）。`);
  }
}

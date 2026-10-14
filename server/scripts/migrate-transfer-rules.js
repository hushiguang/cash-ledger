// 一次性迁移的种子：把改造前写死在代码里的转账规则，导入到用户的 transfer_rules 表。
// 既可以直接运行（cd server && node scripts/migrate-transfer-rules.js），也会被服务端在启动时自动调用。
// 幂等：同一用户已有的同名同规则不会重复插入。导入后这些规则就变成用户自己的数据，
// 可以在「设置 → 转账规则」页面随意增删改，代码里不再保留任何默认规则。
// 注意：LEGACY 数组只是“过渡桥”，首次跑完、确认无误后，可把它清空；之后规则全在数据库里。
import { db } from '../src/db.js';
import { fileURLToPath } from 'node:url';

// 改造前的规则映射（target 为账户名，导入时解析成账户 id）。
const LEGACY = [
  { label: '信用卡还款', pattern: '信用卡还款|待清算信用卡', target: '招商银行信用卡(3116)' },
  { label: '支付宝提现', pattern: '支付宝转账|胡仕广.*提现', target: '支付宝余额' },
  { label: '京东白条还款', pattern: '白条', target: '京东白条' },
  { label: '花呗还款', pattern: '花呗', target: '花呗' },
  { label: '网商银行', pattern: '网商银行', target: '网商银行储蓄卡(9869)' },
  { label: '京东小金库', pattern: '京东小金库|肯特瑞', target: '京东小金库' },
  // 只有「类型判定」没有「转入账户」的旧规则
  { label: '投资理财', pattern: '投资理财', target: null },
];

function guessKind(name) {
  if (/银行/.test(name)) return 'bank';
  if (/支付宝|余额宝/.test(name)) return 'alipay';
  if (/花呗|白条/.test(name)) return 'credit';
  if (/微信|零钱|零钱通/.test(name)) return 'wechat';
  return 'other';
}

function resolveTargetAccountId(userId, name) {
  if (!name) return null;
  const existing = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND name = ?').get(userId, name);
  if (existing) return existing.id;
  const info = db.prepare(
    'INSERT INTO accounts (user_id, name, kind, initial_cents, sort, archived, created_at) VALUES (?, ?, ?, 0, 0, 0, ?)',
  ).run(userId, name, guessKind(name), new Date().toISOString());
  return Number(info.lastInsertRowid);
}

// 幂等导入：只给“还没有任何转账规则”的用户补种子，避免覆盖用户后来的自定义。
export function seedTransferRules() {
  const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
  if (!users.length) return { users: 0, added: 0 };
  let added = 0;
  for (const user of users) {
    const has = db.prepare('SELECT 1 FROM transfer_rules WHERE user_id = ? LIMIT 1').get(user.id);
    if (has) continue;
    for (const def of LEGACY) {
      const targetAccountId = resolveTargetAccountId(user.id, def.target);
      db.prepare(`
        INSERT INTO transfer_rules (user_id, label, pattern, is_regex, target_account_id, enabled, position, created_at)
        VALUES (?, ?, ?, 1, ?, 1, 0, ?)
      `).run(user.id, def.label, def.pattern, targetAccountId, new Date().toISOString());
      added += 1;
    }
  }
  return { users: users.length, added };
}

// 仅在直接运行本脚本时才打印/退出；被服务端 import 时不执行。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = seedTransferRules();
  if (result.users === 0) {
    console.log('没有用户，跳过。');
  } else {
    console.log(`迁移完成：为 ${result.users} 个用户导入 ${result.added} 条转账规则。可在「设置 → 转账规则」页面查看和调整。`);
  }
}

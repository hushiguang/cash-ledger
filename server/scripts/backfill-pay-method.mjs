#!/usr/bin/env node
// 给历史账单的备注补上「收/付款方式」。
// 早期导入的账单没记这一行，账户名就是支付方式归一化后的结果（尾号大多还在）。
//
//   node --experimental-sqlite server/scripts/backfill-pay-method.mjs --dry-run
//   node --experimental-sqlite server/scripts/backfill-pay-method.mjs
//   DATABASE_PATH=/data/ledger.db node --experimental-sqlite server/scripts/backfill-pay-method.mjs
//
// 已经带这一行的账单不会被改动，重复跑是安全的。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyUser = Number((args.find((a) => a.startsWith('--user=')) || '').split('=')[1]) || null;

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'ledger.db');
if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

// 备注里已经有支付方式（或收/付款方式）的就不动
const where = `
  WHERE COALESCE(t.note, '') NOT LIKE '%支付方式：%'
    AND COALESCE(t.note, '') NOT LIKE '%收/付款方式：%'
    AND COALESCE(a.name, '') <> ''
    ${onlyUser ? 'AND t.user_id = ?' : ''}
`;
const sql = `
  SELECT t.id, t.user_id, t.note, a.name AS account_name
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  ${where}
  ORDER BY t.id
`;
const rows = onlyUser ? db.prepare(sql).all(onlyUser) : db.prepare(sql).all();

console.log(`数据库：${dbPath}${dryRun ? '（演练，不会改动）' : ''}`);
console.log(`待补：${rows.length} 笔`);
for (const row of rows.slice(0, 5)) {
  console.log(`  例如 #${row.id}：${(row.note || '').split('\n')[0] || '(无备注)'} → ${row.account_name}`);
}
if (dryRun || !rows.length) process.exit(0);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${dbPath}.bak-${stamp}`;
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`已备份：${backup}`);

const update = db.prepare('UPDATE transactions SET note = ? WHERE id = ?');
db.exec('BEGIN');
try {
  for (const row of rows) {
    const line = `收/付款方式：${row.account_name}`;
    const note = row.note ? `${row.note}\n${line}` : line;
    update.run(note, row.id);
  }
  db.exec('COMMIT');
  console.log(`已补齐 ${rows.length} 笔`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('回填失败，已回滚：', err.message);
  process.exit(1);
}
db.close();

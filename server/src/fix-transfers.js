// 处理「只有转出账户、没有转入账户」的转账流水。
// 这些钱从账户扣掉了却没有去处，余额凭空少掉。分三类处理：
//   1) 能认出去处的（信用卡还款、支付宝提现、白条、花呗、网商银行、小金库）补上转入账户
//   2) 其实是消费/收入的（京东平台商户、京东外卖、理财买入等）改回真实类型，沿用账单自带分类
//   3) 认不准的（个贷放款）原样保留，列出来人工确认
//      —— 2026-04-22 那笔已确认：银行放款进账记收入、再从卡上划走记支出，一进一出。
//         同类流水方向取决于原始账单的正负号，导入时认不出来，遇到需要人工确认。
// 运行：cd server && node src/fix-transfers.js --apply
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDirPath } from './db.js';
import { ensureCategory } from './ledger.js';
import { inferTransferTarget } from './transfer-rules.js';

const BASE = "t.user_id = ? AND t.type = 'transfer' AND t.to_account_id IS NULL";

function accountOf(userId, name) {
  const row = db.prepare('SELECT * FROM accounts WHERE user_id = ? AND name = ?').get(userId, name);
  if (!row) throw new Error(`缺少账户：${name}`);
  return row;
}

// 账单备注里一般带着原始分类，例如「交易类型：数码电器」
function rawCategory(row) {
  const matched = String(row.note || '').match(/交易类型：([^\n]+)/);
  return matched ? matched[1].trim() : '';
}

function isAmbiguous(row) {
  return /个贷放款|个贷交易/.test(`${row.payee || ''} ${row.note || ''}`);
}

function plan(userId) {
  const rows = db.prepare(`
    SELECT t.*, a.name AS account_name
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE ${BASE} ORDER BY t.occurred_at, t.id
  `).all(userId);
  const assigned = [];
  const converted = [];
  const skipped = [];
  const linked = new Map();
  for (const row of rows) {
    const hit = inferTransferTarget(row);
    if (hit) {
      const target = accountOf(userId, hit.target);
      if (target.id !== row.account_id) {
        linked.set(hit.label, (linked.get(hit.label) || 0) + 1);
        assigned.push({ row, targetId: target.id });
        continue;
      }
    }
    if (isAmbiguous(row)) { skipped.push(row); continue; }
    const raw = rawCategory(row);
    const type = raw === '收入' ? 'income' : 'expense';
    converted.push({ row, type, raw });
  }
  return { assigned, converted, skipped, linked, total: rows.length };
}

function apply(userId) {
  const { assigned, converted } = plan(userId);
  const setTo = db.prepare('UPDATE transactions SET to_account_id = ? WHERE id = ?');
  const setType = db.prepare('UPDATE transactions SET type = ?, category_id = ?, to_account_id = NULL WHERE id = ?');
  let linkedCount = 0;
  let convertedCount = 0;
  const ids = [];
  db.exec('BEGIN');
  try {
    for (const item of assigned) linkedCount += setTo.run(item.targetId, item.row.id).changes;
    for (const item of converted) {
      const category = ensureCategory(userId, item.type, item.raw || '', '');
      convertedCount += setType.run(item.type, category.id, item.row.id).changes;
      ids.push(item.row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { linkedCount, convertedCount, ids };
}

const isApply = process.argv.includes('--apply');
let totalLinked = 0;
let totalConverted = 0;
const allIds = [];

for (const user of db.prepare('SELECT id, username FROM users ORDER BY id').all()) {
  const { assigned, converted, skipped, linked, total } = plan(user.id);
  const sum = (rows) => (rows.reduce((s, r) => s + r.amount_cents, 0) / 100).toFixed(2);
  console.log(`\n[${user.username}] 待处理 ${total} 笔`);
  for (const [label, n] of linked) console.log(`  补转入账户 · ${label}: ${n} 笔`);
  console.log(`  改回真实类型：${converted.length} 笔，合计 ${sum(converted.map((item) => item.row))}`);
  for (const row of skipped) {
    console.log(`  保留待确认：${row.occurred_at.slice(0, 10)} ${(row.amount_cents / 100).toFixed(2)} ${row.account_name} → ${row.payee}`);
  }
  if (isApply) {
    const done = apply(user.id);
    totalLinked += done.linkedCount;
    totalConverted += done.convertedCount;
    allIds.push(...done.ids);
  }
}

if (isApply) {
  const file = path.join(dataDirPath(), 'fix-transfers-ids.json');
  fs.writeFileSync(file, JSON.stringify(allIds));
  console.log(`\n已处理：补转入账户 ${totalLinked} 笔，改回真实类型 ${totalConverted} 笔`);
  console.log(`改过的流水 id 已存到 ${file}，需要回退时可用它还原为转账。`);
} else {
  console.log('\n这是预览，加 --apply 才会写入。');
}

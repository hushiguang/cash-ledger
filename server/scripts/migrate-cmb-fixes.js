// 一次性迁移的种子：把改造前写死在 importers.js 里的招行 PDF 姓名乱码修复，
// 改成按用户存数据库的 cmb_text_fixes 表（「乱码片段 → 正确文本」）。
// 既可以直接运行（cd server && node scripts/migrate-cmb-fixes.js），也会被服务端启动时自动调用。
// 幂等：同一用户已有的相同乱码片段不会重复插入，也不会覆盖用户的自定义。
// 注意：FIXES 数组只是“过渡桥”，首次跑完、确认无误后，可把它清空；之后规则全在数据库里，由页面维护。
import { db } from '../src/db.js';
import { fileURLToPath } from 'node:url';

// [乱码片段, 正确文本, 顺序]
const FIXES = [
  ['倿仕广报摞廄岗', '胡仕广报销到岗', 0],
  ['倿', '胡', 1],
];

export function seedCmbGarbleFixes() {
  const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
  if (!users.length) return { users: 0, added: 0 };
  let added = 0;
  for (const user of users) {
    for (const [garbled, correct, position] of FIXES) {
      const dup = db.prepare('SELECT 1 FROM cmb_text_fixes WHERE user_id = ? AND garbled = ?').get(user.id, garbled);
      if (dup) continue;
      db.prepare(`
        INSERT INTO cmb_text_fixes (user_id, garbled, correct, enabled, position, created_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(user.id, garbled, correct, position, new Date().toISOString());
      added += 1;
    }
  }
  return { users: users.length, added };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = seedCmbGarbleFixes();
  if (r.users === 0) {
    console.log('没有用户，跳过。');
  } else {
    console.log(`招行乱码修复种子导入完成：为 ${r.users} 个用户新增 ${r.added} 条（可在「招行乱码修复」页维护）。`);
  }
}

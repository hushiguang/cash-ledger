#!/usr/bin/env -S node --experimental-sqlite
// 把本地开发库导出成 Docker 用的 ./data/ledger.db。
// 用 VACUUM INTO 做一致性快照，不用停本地服务，也不会把 WAL 带过去。
//
//   node --experimental-sqlite scripts/export-db.mjs
//   SRC_DB=/path/to/ledger.db OUT_DIR=/path/to/data node --experimental-sqlite scripts/export-db.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.env.SRC_DB || path.join(root, 'server', 'data', 'ledger.db'));
const outDir = path.resolve(process.env.OUT_DIR || path.join(root, 'data'));
const out = path.join(outDir, 'ledger.db');

if (!fs.existsSync(src)) {
  console.error(`找不到源数据库：${src}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

// 旧库先留个备份，VACUUM INTO 不允许覆盖已存在的文件
if (fs.existsSync(out)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(out, `${out}.bak-${stamp}`);
  console.log(`旧库已备份：${out}.bak-${stamp}`);
}
// 旧的 WAL/SHM 不能留，否则新库打开时会去读它
for (const suffix of ['-wal', '-shm']) {
  const file = `${out}${suffix}`;
  if (fs.existsSync(file)) fs.rmSync(file);
}

const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
const { count } = db.prepare('SELECT COUNT(*) AS count FROM transactions').get();
db.close();

const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`已导出 ${out}（${size} MB，${count} 笔账单）`);
console.log('接下来：docker compose up -d --build');

#!/usr/bin/env node
// 出游账本 Excel 导入。
//
// 支持的表格列（表头名匹配，找不到就按这个默认顺序取）：
//   付款人 | 费用 | 费用类型 | 费用详情 | 日期
//
// 用法：
//   FILE=/path/to/旅行.xlsx BOOK_NAME=东北国庆旅行 \
//   BASE_URL=http://127.0.0.1:8080 USERNAME=leo PASSWORD=xxx \
//   node scripts/import-travel.mjs
//
// 环境变量：
//   FILE        Excel 路径（也可作第一个参数）
//   BOOK_NAME   账本名，已存在就复用，不存在就新建 travel 账本，默认「出游账本」
//   BASE_URL    服务地址，默认 http://127.0.0.1:8080
//   USERNAME    登录用户名，默认 leo
//   PASSWORD    登录密码；也可以直接给 TOKEN 跳过登录
//   FORCE=1     账本里已有账单时也继续导入（会重复，慎用）
//
// 付款人写进 member_name，费用类型写进 category_label，费用详情写进 payee，
// 出游账本允许不填账户，所以 accountId 留空。

import fs from 'node:fs';
import XLSX from 'xlsx';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const FILE = process.env.FILE || process.argv[2];
const BOOK_NAME = process.env.BOOK_NAME || '出游账本';
const USERNAME = process.env.USERNAME || 'leo';
const PASSWORD = process.env.PASSWORD || '';
const FORCE = process.env.FORCE === '1';

function pad(n) {
  return String(n).padStart(2, '0');
}

// Excel 里日期常是 5 位序列号（1900 起算），也有直接写文本的
function toOccurredAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} 12:00:00`;
  }
  const s = String(value ?? '').trim().replace(/\//g, '-');
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} 12:00:00`;
  }
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])} 12:00:00`;
  return null;
}

function toCents(value) {
  const n = Number(String(value ?? '').replace(/[¥￥,\s元]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

async function call(token, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} 失败(${res.status})：${data.message || res.statusText}`);
  return data;
}

async function login() {
  if (process.env.TOKEN) return process.env.TOKEN;
  if (!PASSWORD) throw new Error('缺少登录密码：设置 PASSWORD 或直接给 TOKEN');
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`登录失败：${data.message || res.statusText}`);
  return data.token;
}

function readRows() {
  if (!FILE) throw new Error('缺少 Excel 路径：设置 FILE 或作为第一个参数传入');
  if (!fs.existsSync(FILE)) throw new Error(`文件不存在：${FILE}`);
  const wb = XLSX.readFile(FILE);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  const header = (raw[0] || []).map((c) => String(c || '').trim());
  const col = (...names) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  };
  // 表头能认出来就按名字取，认不出来退回「付款人|费用|费用类型|费用详情|日期」的顺序
  const idx = {
    member: col('付款人', '成员', '谁付的'),
    amount: col('费用', '金额', '金额(元)'),
    category: col('费用类型', '分类'),
    detail: col('费用详情', '说明', '备注', '商品'),
    date: col('日期', '时间'),
  };
  const fallback = { member: 0, amount: 1, category: 2, detail: 3, date: 4 };
  const pick = (row, key) => {
    const i = idx[key] >= 0 ? idx[key] : fallback[key];
    return row[i];
  };

  return raw.slice(1).map((row, i) => {
    const amountCents = toCents(pick(row, 'amount'));
    const occurredAt = toOccurredAt(pick(row, 'date'));
    const detail = String(pick(row, 'detail') ?? '').trim();
    const memberName = String(pick(row, 'member') ?? '').trim();
    const categoryLabel = String(pick(row, 'category') ?? '').trim();
    const skipReason = !amountCents ? '金额为空或不是数字'
      : !occurredAt ? '日期无法识别'
        : null;
    return {
      line: i + 2,
      type: 'expense',
      amountCents,
      occurredAt,
      payee: detail,
      note: detail,
      memberName: memberName || null,
      categoryLabel: categoryLabel || null,
      skipReason,
    };
  });
}

async function main() {
  const rows = readRows();
  const ready = rows.filter((r) => !r.skipReason);
  const skipped = rows.filter((r) => r.skipReason);
  console.log(`表格 ${rows.length} 行，可导入 ${ready.length} 行，跳过 ${skipped.length} 行`);
  for (const r of skipped) console.log(`  跳过第 ${r.line} 行：${r.skipReason}`);
  if (!ready.length) throw new Error('没有可导入的行');

  const token = await login();

  // 账本：同名就复用，没有就建一个出游共享账本
  const { books } = await call(token, '/api/books');
  let book = (books || []).find((b) => b.name === BOOK_NAME);
  if (!book) {
    const created = await call(token, '/api/books', { name: BOOK_NAME, kind: 'travel' });
    book = created.book;
    console.log(`已创建账本「${BOOK_NAME}」id=${book.id}`);
  } else {
    console.log(`复用账本「${BOOK_NAME}」id=${book.id}`);
  }

  // 防重：同一本账本再跑一次会把账单导两遍
  const before = await call(token, `/api/transactions?bookId=${book.id}&limit=1`);
  if (before.total > 0 && !FORCE) {
    throw new Error(`账本「${BOOK_NAME}」里已有 ${before.total} 笔账单，确认要重复导入就加 FORCE=1`);
  }

  const result = await call(token, '/api/import/commit', {
    bookId: book.id,
    source: 'custom',
    rows: ready,
  });
  console.log(`导入完成：成功 ${result.inserted}，重复 ${result.duplicated}，失败 ${result.failed}`);

  const byMember = new Map();
  for (const r of ready) {
    const key = r.memberName || '未注明';
    byMember.set(key, (byMember.get(key) || 0) + r.amountCents);
  }
  const total = ready.reduce((sum, r) => sum + r.amountCents, 0);
  console.log(`合计 ${(total / 100).toFixed(2)} 元`);
  for (const [name, cents] of byMember) {
    console.log(`  ${name}：${(cents / 100).toFixed(2)} 元`);
  }
}

main().catch((err) => {
  console.error('导入失败：', err.message);
  process.exit(1);
});

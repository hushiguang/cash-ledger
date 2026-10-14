// 转账规则：全部存在数据库里，由用户在页面上配置，代码不写死任何个人账号/姓名。
// 一条规则 = 「账单的 对方/备注/分类 里出现某关键词（或正则），就把这笔当成转账，
// 可选地指定转入账户（从用户自己的账户里选）」。
// 导入预览和存量修补（fix-transfers.js）共用这一份引擎，两边逻辑不会跑偏。

import { db } from './db.js';

function safeRegexTest(pattern, text) {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return false;
  }
}

export function listTransferRules(userId) {
  return db.prepare(
    'SELECT * FROM transfer_rules WHERE user_id = ? ORDER BY position, id',
  ).all(userId);
}

export function getTransferRule(userId, id) {
  return db.prepare(
    'SELECT * FROM transfer_rules WHERE id = ? AND user_id = ?',
  ).get(id, userId);
}

function validateBody(body) {
  const label = String(body.label || '').trim();
  const pattern = String(body.pattern || '').trim();
  if (!label) return '请填写规则名称';
  if (!pattern) return '请填写匹配关键词或正则';
  const isRegex = body.isRegex ? 1 : 0;
  if (isRegex && !safeRegexTest(pattern, '')) return '正则表达式无效';
  let targetAccountId = null;
  if (body.targetAccountId) {
    const id = Number(body.targetAccountId);
    const acct = db.prepare(
      'SELECT id FROM accounts WHERE id = ? AND user_id = ?',
    ).get(id, NaN);
    if (!acct) return '转入账户不存在';
    targetAccountId = id;
  }
  const enabled = body.enabled === false ? 0 : 1;
  return { label, pattern, isRegex, targetAccountId, enabled };
}

export function createTransferRule(userId, body) {
  const valid = validateBody(body);
  if (typeof valid === 'string') throw Object.assign(new Error(valid), { status: 400 });
  const max = db.prepare(
    'SELECT COALESCE(MAX(position), 0) AS m FROM transfer_rules WHERE user_id = ?',
  ).get(userId);
  const info = db.prepare(`
    INSERT INTO transfer_rules (user_id, label, pattern, is_regex, target_account_id, enabled, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, valid.label, valid.pattern, valid.isRegex, valid.targetAccountId, valid.enabled,
    max.m + 1, new Date().toISOString(),
  );
  return getTransferRule(userId, Number(info.lastInsertRowid));
}

export function updateTransferRule(userId, id, body) {
  const existing = getTransferRule(userId, id);
  if (!existing) throw Object.assign(new Error('规则不存在'), { status: 404 });
  const valid = validateBody(body);
  if (typeof valid === 'string') throw Object.assign(new Error(valid), { status: 400 });
  db.prepare(`
    UPDATE transfer_rules
    SET label = ?, pattern = ?, is_regex = ?, target_account_id = ?, enabled = ?
    WHERE id = ? AND user_id = ?
  `).run(
    valid.label, valid.pattern, valid.isRegex, valid.targetAccountId, valid.enabled,
    id, userId,
  );
  return getTransferRule(userId, id);
}

export function deleteTransferRule(userId, id) {
  const existing = getTransferRule(userId, id);
  if (!existing) throw Object.assign(new Error('规则不存在'), { status: 404 });
  db.prepare('DELETE FROM transfer_rules WHERE id = ? AND user_id = ?').run(id, userId);
  return existing;
}

// 在 payee / note / categoryName 拼成的文本上匹配规则，返回命中的规则或 null。
export function matchTransferRule(userId, fields) {
  const haystack = [
    fields.payee || '',
    fields.note || '',
    fields.categoryName || '',
  ].join(' ');
  const rules = listTransferRules(userId);
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const hit = rule.is_regex
      ? safeRegexTest(rule.pattern, haystack)
      : haystack.includes(rule.pattern);
    if (hit) return rule;
  }
  return null;
}

// 解析阶段调用：命中规则就把这笔标记为转账，并按需补上转入账户（id + 名称，供预览展示）。
export function applyTransferRules(userId, row) {
  const rule = matchTransferRule(userId, row);
  if (!rule) return row;
  row.type = 'transfer';
  // 转账不计收支，清掉分类
  row.categoryName = '';
  row.categoryLabel = '';
  if (rule.target_account_id) {
    const acct = db.prepare(
      'SELECT id, name FROM accounts WHERE id = ? AND user_id = ?',
    ).get(rule.target_account_id, userId);
    if (acct && acct.id !== row.accountId) {
      row.toAccountId = acct.id;
      row.toAccountName = acct.name;
    }
  }
  return row;
}

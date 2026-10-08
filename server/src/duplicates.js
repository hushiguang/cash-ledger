// 查重：微信/支付宝绑着银行卡时，同一笔消费可能在银行卡流水和钱包流水里各记一条。
// 这里把「金额相同 + 时间接近 + 分属不同账户」的支出（或收入）配成对，按相似度打分。

import { db } from './db.js';
import { centsToYuan } from './money.js';
import { presentTransaction, selectTransactions } from './ledger.js';

// 一方备注里出现渠道名、另一方账户是同一渠道的钱包 → 基本就是同一次支付的两边记录
const CHANNELS = [
  { key: '微信', payee: /财付通|微信支付|微信转账|微信扫码|wechat/i, account: /微信|零钱/ },
  { key: '支付宝', payee: /支付宝|蚂蚁|alipay|花呗|网商/i, account: /支付宝|余额宝|花呗|网商/ },
];

function normalizeText(text) {
  return String(text || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[-—_\s·、,，。.:：/|*]/g, '')
    .toLowerCase();
}

function toMinutes(text) {
  const m = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)) / 60000;
}

function dayOf(text) {
  return String(text || '').slice(0, 10);
}

// 最长的连续公共片段，用来判断两个商户名有多像
function longestCommon(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k += 1;
      if (k > best) best = k;
    }
  }
  return best;
}

// 同一个账户里的两笔要报为重复，至少需要这个分数：
// 同一时刻(+30) + 商户名一致(+22) + 基线 40 = 92，只有「同额同时刻但商户名对不上」的 70 分会被挡掉
const SAME_ACCOUNT_MIN_SCORE = 75;

// 备注里记的商户单号（跨平台可能是同一个，能互证是同一笔消费）
function merchantOrderOf(text) {
  const m = String(text || '').match(/(?:商户订单号|商家订单号|商户单号单号|商户单号)[：:]\s*([A-Za-z0-9_-]{8,})/);
  return m ? m[1] : '';
}

function externalIdOf(row) {
  return String(row.external_id || '').trim();
}

function channelMatch(from, to) {
  for (const ch of CHANNELS) {
    if (ch.payee.test(from.payee || '') && ch.account.test(to.account_name || '')) return ch.key;
    if (ch.payee.test(from.note || '') && ch.account.test(to.account_name || '')) return ch.key;
  }
  return null;
}

export function scorePair(a, b) {
  const reasons = [];

  // 交易单号一样 = 同一笔账单被记了两次，这是最硬的证据，不用再看别的
  const ea = externalIdOf(a);
  const eb = externalIdOf(b);
  if (ea && ea === eb) return { score: 100, reasons: ['交易单号相同'] };

  let score = 40; // 金额相同且分属不同账户

  const aMin = toMinutes(a.occurred_at);
  const bMin = toMinutes(b.occurred_at);
  const gapMin = Math.abs(aMin - bMin);
  if (String(a.occurred_at) === String(b.occurred_at)) {
    score += 30;
    reasons.push('同一时刻');
  } else if (dayOf(a.occurred_at) === dayOf(b.occurred_at)) {
    score += 20;
    reasons.push('同一天');
  } else {
    const hours = Math.round(gapMin / 60);
    score += 8;
    reasons.push(hours < 24 ? `相隔 ${hours} 小时` : `相差 ${Math.round(hours / 24)} 天`);
  }

  const na = normalizeText(a.payee);
  const nb = normalizeText(b.payee);
  if (na && nb && (na.includes(nb) || nb.includes(na))) {
    score += 22;
    reasons.push('商户名一致');
  } else if (longestCommon(na, nb) >= 2) {
    score += 10;
    reasons.push('商户名相近');
  }

  const channel = channelMatch(a, b) || channelMatch(b, a);
  if (channel) {
    score += 20;
    reasons.push(`${channel}渠道互证`);
  }

  // 银行卡流水和钱包流水记的商户单号可能是同一个
  const ma = merchantOrderOf(a.note);
  const mb = merchantOrderOf(b.note);
  if (ma && ma === mb) {
    score += 25;
    reasons.push('商户单号相同');
  }

  if (Number(a.amount_cents) >= 5000) score += 5; // 大额偶然撞号的概率低

  return { score: Math.min(score, 100), reasons };
}

export function pairKey(aId, bId) {
  return `${Math.min(aId, bId)}-${Math.max(aId, bId)}`;
}

export function findDuplicatePairs(userId, options = {}) {
  const type = ['expense', 'income'].includes(options.type) ? options.type : 'expense';
  const windowDays = Number(options.windowDays) > 0 ? Number(options.windowDays) : 1;
  const minScore = Number(options.minScore) || 0;
  const minCents = Number(options.minCents) || 0;

  // from/to 限制账目范围（不传就是全部），windowDays 限制两笔之间允许相差多少天
  let sql = `
    SELECT t1.id AS a_id, t2.id AS b_id
    FROM transactions t1
    JOIN transactions t2
      ON t2.user_id = t1.user_id
      AND t2.type = t1.type
      AND t2.amount_cents = t1.amount_cents
      AND t2.id > t1.id
    JOIN accounts a1 ON a1.id = t1.account_id
    JOIN accounts a2 ON a2.id = t2.account_id
    WHERE t1.user_id = ? AND t1.type = ?
      AND t1.amount_cents >= ?
      AND ABS(julianday(t2.occurred_at) - julianday(t1.occurred_at)) <= ?
      AND COALESCE(a1.merged_into, a1.id) <> COALESCE(a2.merged_into, a2.id)
  `;
  const args = [userId, type, minCents, windowDays];
  // 只在一个账本里查重：跨账本的同类同额账单不是重复
  if (options.bookId) {
    sql += ' AND t1.book_id = ? AND t2.book_id = ?';
    args.push(Number(options.bookId), Number(options.bookId));
  }
  if (options.from) {
    sql += ' AND t1.occurred_at >= ?';
    args.push(String(options.from).slice(0, 10));
  }
  if (options.to) {
    sql += " AND t1.occurred_at < date(?, '+1 day')";
    args.push(String(options.to).slice(0, 10));
  }
  sql += ' ORDER BY t1.occurred_at DESC';
  const candidates = db.prepare(sql).all(...args);

  // 交易单号相同 = 同一笔账单被导入了两次。它可能落在同一个账户上，
  // 上面的「同额 + 分属不同账户」匹配抓不到，所以单独再找一遍。
  const idArgs = [userId, type];
  let idSql = `
    SELECT t1.id AS a_id, t2.id AS b_id
    FROM transactions t1
    JOIN transactions t2
      ON t2.user_id = t1.user_id
      AND t2.type = t1.type
      AND t2.id > t1.id
      AND TRIM(COALESCE(t1.external_id, '')) <> ''
      AND TRIM(COALESCE(t2.external_id, '')) = TRIM(COALESCE(t1.external_id, ''))
    WHERE t1.user_id = ? AND t1.type = ?
  `;
  if (options.bookId) {
    idSql += ' AND t1.book_id = ? AND t2.book_id = ?';
    idArgs.push(Number(options.bookId), Number(options.bookId));
  }
  if (options.from) {
    idSql += ' AND t1.occurred_at >= ?';
    idArgs.push(String(options.from).slice(0, 10));
  }
  if (options.to) {
    idSql += " AND t1.occurred_at < date(?, '+1 day')";
    idArgs.push(String(options.to).slice(0, 10));
  }
  const seen = new Set(candidates.map((row) => `${row.a_id}-${row.b_id}`));
  for (const row of db.prepare(idSql).all(...idArgs)) {
    const key = `${row.a_id}-${row.b_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(row);
  }

  // 微信/支付宝绑着银行卡消费时，钱包账单的「支付方式」会被归一成那张银行卡，
  // 于是和银行流水落在同一个账户上 —— 上面的「分属不同账户」条件正好把它们漏掉。
  // 这里单独找「同账户 + 同一时刻 + 同额」，交给下面按更严的分数门槛判定。
  const sameArgs = [userId, type, minCents];
  let sameSql = `
    SELECT t1.id AS a_id, t2.id AS b_id, 1 AS same_account
    FROM transactions t1
    JOIN transactions t2
      ON t2.user_id = t1.user_id
      AND t2.type = t1.type
      AND t2.amount_cents = t1.amount_cents
      AND t2.occurred_at = t1.occurred_at
      AND t2.id > t1.id
    JOIN accounts a1 ON a1.id = t1.account_id
    JOIN accounts a2 ON a2.id = t2.account_id
    WHERE t1.user_id = ? AND t1.type = ?
      AND t1.amount_cents >= ?
      AND COALESCE(a1.merged_into, a1.id) = COALESCE(a2.merged_into, a2.id)
  `;
  if (options.bookId) {
    sameSql += ' AND t1.book_id = ? AND t2.book_id = ?';
    sameArgs.push(Number(options.bookId), Number(options.bookId));
  }
  if (options.from) {
    sameSql += ' AND t1.occurred_at >= ?';
    sameArgs.push(String(options.from).slice(0, 10));
  }
  if (options.to) {
    sameSql += " AND t1.occurred_at < date(?, '+1 day')";
    sameArgs.push(String(options.to).slice(0, 10));
  }
  for (const row of db.prepare(sameSql).all(...sameArgs)) {
    const key = `${row.a_id}-${row.b_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(row);
  }

  if (!candidates.length) return [];
  const ids = [...new Set(candidates.flatMap((row) => [row.a_id, row.b_id]))];
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`${selectTransactions()} WHERE t.id IN (${marks})`).all(...ids);
  const txMap = new Map(rows.map((row) => [row.id, row]));

  const ignored = new Set(
    db.prepare('SELECT pair_key FROM duplicate_ignores WHERE user_id = ?').all(userId).map((row) => row.pair_key),
  );

  const pairs = [];
  for (const c of candidates) {
    const a = txMap.get(c.a_id);
    const b = txMap.get(c.b_id);
    if (!a || !b) continue;
    const key = pairKey(c.a_id, c.b_id);
    if (ignored.has(key)) continue;
    const { score, reasons } = scorePair(a, b);
    // 同一个账户里的两笔，要有足够硬的证据才报：比如同一时刻 + 商户名一致 + 单号相同。
    // 否则「连着买两杯一样的咖啡」会被误判成重复。
    if (c.same_account && score < SAME_ACCOUNT_MIN_SCORE) continue;
    if (score < minScore) continue;
    pairs.push({
      key,
      score,
      reasons,
      amount: centsToYuan(a.amount_cents),
      a: presentTransaction(a),
      b: presentTransaction(b),
    });
  }
  const byTime = (x, y) => String(y.a.occurredAt).localeCompare(String(x.a.occurredAt)) || y.score - x.score;
  const byScore = (x, y) => y.score - x.score || String(y.a.occurredAt).localeCompare(String(x.a.occurredAt));
  return pairs.sort(options.sort === 'score' ? byScore : byTime);
}

export function listIgnores(userId) {
  return db.prepare('SELECT pair_key FROM duplicate_ignores WHERE user_id = ? ORDER BY id DESC').all(userId)
    .map((row) => row.pair_key);
}

export function ignorePair(userId, key) {
  db.prepare('INSERT OR IGNORE INTO duplicate_ignores (user_id, pair_key, created_at) VALUES (?, ?, ?)')
    .run(userId, String(key), new Date().toISOString());
}

export function unignorePair(userId, key) {
  if (key) db.prepare('DELETE FROM duplicate_ignores WHERE user_id = ? AND pair_key = ?').run(userId, String(key));
  else db.prepare('DELETE FROM duplicate_ignores WHERE user_id = ?').run(userId);
}

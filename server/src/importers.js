import iconv from 'iconv-lite';
import XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import { parseDateTime } from './dates.js';
import { amountMark, yuanToCents } from './money.js';
import { inferTransferTarget } from './transfer-rules.js';
import { resolveCategoryPath } from './taxonomy.js';

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export function cleanCell(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/^`/, '').replace(/\t/g, '').trim();
}

export function decodeText(buffer) {
  const buf = Buffer.from(buffer);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8');
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD') && /交易|时间|金额|分类/.test(utf8)) return utf8;
  return iconv.decode(buf, 'gbk');
}

export function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map(cleanCell));
}

function detectDelim(text) {
  const lines = text.split(/\r?\n/).slice(0, 40);
  const line = lines.find((l) => /金额|交易时间|收\/支|账户1/.test(l)) || lines[0] || '';
  const scores = [
    [',', (line.match(/,/g) || []).length],
    ['\t', (line.match(/\t/g) || []).length],
    [';', (line.match(/;/g) || []).length],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ',';
}

export function loadTable(buffer, filename = '') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1, raw: true, defval: '', blankrows: false,
    });
    return rows.map((r) => (Array.isArray(r) ? r : [r]).map(cleanCell));
  }
  const text = decodeText(buffer);
  return parseCsv(text, detectDelim(text));
}

function normHeader(h) {
  return cleanCell(h).replace(/\s/g, '').replace(/（元）|\(元\)/g, '');
}

export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 80); i += 1) {
    const cells = rows[i].map(normHeader);
    const hasTime = cells.some((c) => /交易时间|付款时间|交易创建时间|^时间$|^日期$/.test(c));
    // 出游账本的表头是「付款人/费用/费用类型/费用详情/日期」，没有「金额」二字
    const hasMoney = cells.some((c) => c === '金额' || c.includes('金额') || c === '收/支' || c === '类型' || c === '费用' || c === '费用类型');
    if (hasTime && hasMoney && cells.filter(Boolean).length >= 3) return i;
  }
  return -1;
}

function col(headers, aliases) {
  const norm = headers.map(normHeader);
  const keys = aliases.map((a) => a.replace(/\s/g, '').replace(/（元）|\(元\)/g, ''));
  for (const a of keys) {
    const i = norm.findIndex((h) => h === a);
    if (i >= 0) return i;
  }
  for (const a of keys) {
    const i = norm.findIndex((h) => h.includes(a));
    if (i >= 0) return i;
  }
  return -1;
}

function at(row, i) {
  if (i < 0) return '';
  return cleanCell(row[i]);
}

const KEYWORDS = [
  ['餐饮', ['美团', '饿了么', '星巴克', '瑞幸', '肯德基', '麦当劳', '外卖', '餐厅']],
  ['交通', ['滴滴', '地铁', '公交', '加油', '停车', '高铁', '12306', '曹操', '铁路']],
  ['购物', ['淘宝', '天猫', '京东', '拼多多', '超市', '盒马', '山姆']],
  ['居住', ['电费', '水费', '燃气', '物业', '房租']],
  ['娱乐', ['电影', '猫眼', '腾讯视频', '爱奇艺', '哔哩哔哩', '网易云', '游戏']],
  ['医疗', ['医院', '药店', '大药房', '医保']],
  ['通讯', ['话费', '中国移动', '中国联通', '中国电信']],
  ['人情', ['红包']],
];

export function guessCategory(text, type) {
  const s = text || '';
  if (type === 'income' && s.includes('红包')) return '红包';
  if (type === 'income') return '';
  for (const [name, words] of KEYWORDS) {
    if (words.some((w) => s.includes(w))) return name;
  }
  return '';
}

function badStatus(status) {
  if (!status) return null;
  if (/失败|交易关闭|已关闭|交易取消/.test(status) && !/退款/.test(status)) return `状态：${status}`;
  return null;
}

function directionOf(value) {
  const s = cleanCell(value);
  if (!s || s === '/' || s === '-' || /不计/.test(s)) return { type: 'transfer', neutral: true };
  if (s.includes('支出') || s === '支' || s === '消费') return { type: 'expense' };
  if (s === '报销') return { type: 'income' };
  if (s.includes('收入') || s === '收') return { type: 'income' };
  if (s.includes('转账') || s.includes('还款')) return { type: 'transfer' };
  return { type: null };
}

function ownLegs(kindText, pocket, payee) {
  if (/零钱提现/.test(kindText) || (/提现/.test(kindText) && !/转账/.test(kindText))) {
    return { accountName: '零钱', toAccountName: pocket || payee || '银行卡' };
  }
  if (/零钱充值/.test(kindText)) {
    return { accountName: pocket || payee || '银行卡', toAccountName: '零钱' };
  }
  if (/转入零钱通/.test(kindText)) return { accountName: '零钱', toAccountName: '零钱通' };
  if (/零钱通转出/.test(kindText)) {
    if (/到零钱/.test(kindText) && !/银行|储蓄卡|信用卡/.test(kindText)) {
      return { accountName: '零钱通', toAccountName: '零钱' };
    }
    const dest = kindText.split('到').slice(1).join('到').replace(/^-/, '').trim();
    const target = pocket && pocket !== '零钱通' ? pocket : (dest || payee || '银行卡');
    return { accountName: '零钱通', toAccountName: target };
  }
  if (/余额宝/.test(kindText) && /转出|提现/.test(kindText)) {
    return { accountName: '余额宝', toAccountName: pocket || '支付宝' };
  }
  if (/余额宝/.test(kindText)) return { accountName: pocket || '支付宝', toAccountName: '余额宝' };
  return null;
}

// 转给别人是支出，别人转来是收入，自己的账户之间才不计收支。
export function decideTransfer({ kind, status, dir = {}, accountName = '', toAccountName = '', payee = '' }) {
  const kindText = cleanCell(kind);
  const statusText = cleanCell(status);
  const from = cleanCell(accountName);
  const to = cleanCell(toAccountName);
  const who = cleanCell(payee);
  const pocket = from && from !== '/' ? from : '';
  const legs = ownLegs(kindText, pocket, who);
  if (legs) return { type: 'transfer', ...legs };
  if (/还款/.test(kindText)) return { type: 'transfer' };

  const personTransfer = /转账/.test(kindText) && !/零钱通|余额宝/.test(kindText);
  if (personTransfer || (dir.type === 'transfer' && !dir.neutral && !to)) {
    if (to && pocket && to !== pocket) return { type: 'transfer' };
    if (/对方已退还/.test(statusText)) {
      const side = pocket || '零钱';
      return { type: 'transfer', accountName: side, toAccountName: side };
    }
    if (/已转入零钱通/.test(statusText)) return { type: 'income', accountName: '零钱通' };
    if (/已存入零钱/.test(statusText)) return { type: 'income', accountName: '零钱' };
    const received = /已存入|已收款|已领取/.test(statusText) || dir.type === 'income';
    if (received && !/对方已收钱/.test(statusText)) {
      return { type: 'income', accountName: pocket || '零钱' };
    }
    return { type: 'expense' };
  }
  if (dir.neutral || dir.type === 'transfer') return { type: 'transfer' };
  return null;
}

function flowOf({ kind, status, dir, accountName, toAccountName, payee }) {
  const kindText = cleanCell(kind);
  const statusText = cleanCell(status);
  const blob = `${kindText} ${statusText}`;
  if (statusText && /失败|交易关闭|已关闭|交易取消/.test(statusText) && !/退款/.test(blob)) {
    return { type: dir.type || null, skipReason: `状态：${statusText}` };
  }
  const who = cleanCell(payee);
  const noCounterparty = !who || who === '/' || who === '-';
  if (/转账/.test(kindText) && /退款/.test(`${kindText} ${statusText}`) && noCounterparty) {
    const side = cleanCell(accountName);
    const pocket = side && side !== '/' ? side : '零钱';
    return { type: 'transfer', skipReason: null, accountName: pocket, toAccountName: pocket };
  }
  if (/退款/.test(kindText) || (/退款/.test(statusText) && dir.type !== 'expense')) {
    return { type: 'income', skipReason: null };
  }
  if (/退款/.test(statusText) && dir.type === 'expense') return { type: 'expense', skipReason: null };
  // 收益、奖励是对方打进来的，不是自己的账户互转。
  if (/收益发放|奖励发放|收益补贴/.test(kindText)) {
    const pocket = cleanCell(accountName);
    const landed = /余额宝/.test(kindText) ? '余额宝' : (pocket && pocket !== '/' ? pocket : '支付宝');
    return { type: 'income', skipReason: null, accountName: landed };
  }
  // 话费、电费、石化钱包等充值是付给对方的，只有零钱、余额宝、零钱通之间才是互转。
  if (/充值/.test(kindText) && !/零钱充值|余额宝|零钱通|转账/.test(kindText)) {
    return { type: 'expense', skipReason: null };
  }
  const transferLike = /转账|还款|充值|提现|零钱通|余额宝/.test(kindText) || dir.type === 'transfer' || dir.neutral;
  if (transferLike) {
    const decided = decideTransfer({ kind: kindText, status: statusText, dir, accountName, toAccountName, payee });
    if (decided) return { skipReason: null, incoming: false, ...decided };
  }
  if (dir.skip) return { type: dir.type || null, skipReason: dir.skip };
  return { type: dir.type || null, skipReason: badStatus(statusText) };
}

function categoryFor(type, text, named = '', fallback = '其他') {
  if (type === 'transfer') return '';
  return named || guessCategory(text, type) || fallback;
}

function blank(row) {
  return {
    occurredAt: row.occurredAt || null,
    type: row.type || null,
    amountCents: row.amountCents ?? null,
    categoryName: row.categoryName || '',
    subcategoryName: row.subcategoryName || '',
    categoryLabel: row.categoryLabel || '',
    accountName: row.accountName || '',
    toAccountName: row.toAccountName || '',
    memberName: row.memberName || '',
    payee: row.payee || '',
    note: row.note || '',
    // 分摊人：null = 没设过（全员平摊），[] = 自己承担，其余是名单
    shareWith: Array.isArray(row.shareWith) ? row.shareWith : null,
    externalId: row.externalId || '',
    skipReason: row.skipReason || null,
    incoming: !!row.incoming,
    };
}

function finalize(row) {
  const item = blank(row);
  if (!item.skipReason) {
    if (!item.occurredAt) item.skipReason = '无法识别时间';
    else if (!item.type) item.skipReason = '无法识别类型';
    else if (item.amountCents == null) item.skipReason = '无法识别金额';
    else if (item.amountCents <= 0) item.skipReason = '金额为 0';
    else {
      const payee = String(item.payee || '');
      const note = String(item.note || '');
      const cat = String(item.categoryName || '');
      // 信用借还、投资理财等不计收支，转为 transfer 类型导入账单
      if (payee.includes('胡仕广支付宝转账')) {
        item.type = 'transfer';
        item.categoryName = '';
      } else if (payee === '信用卡还款' || note === '信用卡还款 | 信用卡还款') {
        item.type = 'transfer';
        item.categoryName = '';
      } else if (payee.includes('肯特瑞小金库网银平台')) {
        item.type = 'transfer';
        item.categoryName = '';
      } else if (cat === '投资理财') {
        item.type = 'transfer';
        item.categoryName = '';
      }
      // 百信银行：去掉不计收支限制，小额利息等正常走分类逻辑
      // 个贷放款不做特殊处理：招商银行流水自带正负号，放款进账是收入、划走是支出。
      // 账单没给「对方账户」时按收款方推断去向，别让钱扣了却没有去处。
      if (item.type === 'transfer' && !item.toAccountName) {
        const hit = inferTransferTarget(item);
        if (hit) item.toAccountName = hit.target;
      }
    }
  }
  if (item.amountCents != null) item.amountCents = Math.abs(item.amountCents);
  return item;
}

function dataRows(matrix) {
  const headerAt = findHeader(matrix);
  if (headerAt < 0) throw new ImportError('没有找到表头，请确认是导出的账单文件');
  const headers = matrix[headerAt].map(cleanCell);
  const rows = [];
  for (let i = headerAt + 1; i < matrix.length; i += 1) {
    const row = matrix[i] || [];
    const first = at(row, 0);
    if (!row.some((c) => cleanCell(c))) continue;
    if (/^共\d+笔|收入：|支出：|中性交易|导出信息|----/.test(first)) continue;
    rows.push(row);
  }
  return { headers, rows };
}

function parseCommon(matrix, pick) {
  const { headers, rows } = dataRows(matrix);
  return rows.map((row) => finalize(pick(headers, row)));
}

function wechatField(text, label) {
  const matched = String(text || '').match(new RegExp(`${label}：([^\\r\\n]*)`));
  return matched ? matched[1].trim() : '';
}

function wechatGoodsAggregated(goods) {
  const text = String(goods || '');
  return text.includes('交易类型：') && text.includes('商品描述：');
}

function wechatNote({ kind, payee, goods, status, id, merchantId, remark, payMethod }) {
  if (wechatGoodsAggregated(goods)) return String(goods);
  return [
    `交易类型：${kind || ''}`,
    `交易对方：${payee || ''}`,
    `商品描述：${goods || ''}`,
    `状态：${status || ''}`,
    `支付方式：${payMethod || ''}`,
    `微信交易单号：${id || ''}`,
    `商户单号单号：${merchantId || ''}`,
    `备注：${remark || ''}`,
  ].join('\n');
}

export function parseWechat(matrix) {
  return parseCommon(matrix, (headers, row) => {
    let kind = at(row, col(headers, ['交易类型']));
    let payee = at(row, col(headers, ['交易对方']));
    const goods = at(row, col(headers, ['商品']));
    const dir = directionOf(at(row, col(headers, ['收/支'])));
    let status = at(row, col(headers, ['当前状态']));
    const account = at(row, col(headers, ['支付方式'])) || '微信';
    let id = at(row, col(headers, ['交易单号']));
    const merchantId = at(row, col(headers, ['商户单号']));
    const remark = at(row, col(headers, ['备注']));
    if (wechatGoodsAggregated(goods)) {
      kind = kind || wechatField(goods, '交易类型');
      payee = payee || wechatField(goods, '交易对方');
      status = status || wechatField(goods, '状态');
      id = id || wechatField(goods, '微信交易单号');
    }
    const flow = flowOf({ kind, status, dir, accountName: account, payee });
    const note = wechatNote({ kind, payee, goods, status, id, merchantId, remark, payMethod: account });
    const described = wechatGoodsAggregated(goods) ? wechatField(goods, '商品描述') : goods;
    const text = `${kind} ${payee} ${described} ${remark}`;
    let accountName = flow.accountName || account;
    if (!accountName || accountName === '/') accountName = /零钱通/.test(status) ? '零钱通' : '零钱';
    return {
      occurredAt: parseDateTime(at(row, col(headers, ['交易时间']))),
      type: flow.type,
      incoming: false,
      amountCents: yuanToCents(at(row, col(headers, ['金额']))),
      categoryName: categoryFor(flow.type, text, '', /转账/.test(kind) ? '转账' : '其他'),
      accountName,
      toAccountName: flow.type === 'transfer' ? (flow.toAccountName || '') : '',
      payee,
      note,
      externalId: id,
      skipReason: flow.skipReason,
    };
  });
}

function alipayNote({ category, payee, accountNo, goods, status, id, merchantId, remark, payMethod }) {
  return [
    `交易类型：${category || ''}`,
    `交易对方：${payee || ''}`,
    `对方账号：${accountNo || ''}`,
    `商品描述：${goods || ''}`,
    `状态：${status || ''}`,
    `收/付款方式：${payMethod || ''}`,
    `支付宝交易单号：${id || ''}`,
    `商户订单号：${merchantId || ''}`,
    `备注：${remark || ''}`,
  ].join('\n');
}

export function parseAlipay(matrix) {
  return parseCommon(matrix, (headers, row) => {
    const category = at(row, col(headers, ['交易分类']));
    let payee = at(row, col(headers, ['交易对方']));
    const accountNo = at(row, col(headers, ['对方账号']));
    const goods = at(row, col(headers, ['商品说明', '商品名称']));
    const dir = directionOf(at(row, col(headers, ['收/支'])));
    let status = at(row, col(headers, ['交易状态']));
    const account = at(row, col(headers, ['收/付款方式'])) || '支付宝';
    let id = at(row, col(headers, ['交易订单号', '交易号']));
    const merchantId = at(row, col(headers, ['商家订单号', '商户订单号']));
    const remark = at(row, col(headers, ['备注']));
    const aggregated = wechatGoodsAggregated(goods);
    const described = aggregated ? wechatField(goods, '商品描述') : goods;
    if (aggregated) {
      payee = payee || wechatField(goods, '交易对方');
      status = status || wechatField(goods, '状态');
      id = id || wechatField(goods, '支付宝交易单号');
    }
    const describedText = `${category} ${described}`;
    const flow = flowOf({ kind: describedText, status, dir, accountName: account, payee });
    const paidToMe = /收益发放|奖励发放|收益补贴/.test(describedText);
    const note = aggregated
      ? String(goods)
      : alipayNote({ category, payee, accountNo, goods: described, status, id, merchantId, remark, payMethod: account });
    return {
      occurredAt: parseDateTime(at(row, col(headers, ['付款时间', '交易时间', '交易创建时间']))),
      type: flow.type,
      incoming: false,
      amountCents: yuanToCents(at(row, col(headers, ['金额']))),
      categoryName: categoryFor(
        flow.type,
        `${payee} ${described} ${remark}`,
        paidToMe ? (/红包奖励/.test(described) ? '红包' : '理财') : category,
        /转账/.test(`${category} ${described}`) ? '转账' : '其他',
      ),
      accountName: flow.accountName || account,
      toAccountName: flow.type === 'transfer' ? (flow.toAccountName || '') : '',
      payee,
      note,
      externalId: id,
      skipReason: flow.skipReason,
    };
  });
}

function jdNote({ category, payee, goods, status, id, merchantId, remark, payMethod }) {
  if (wechatGoodsAggregated(goods)) return String(goods);
  return [
    `交易类型：${category || ''}`,
    `交易对方：${payee || ''}`,
    `对方账号：${payee || ''}`,
    `商品描述：${goods || ''}`,
    `状态：${status || ''}`,
    `收/付款方式：${payMethod || ''}`,
    `京东交易单号：${id || ''}`,
    `商户订单号：${merchantId || ''}`,
    `备注：${remark || ''}`,
  ].join('\n');
}

export function parseJd(matrix) {
  return parseCommon(matrix, (headers, row) => {
    const time = at(row, col(headers, ['交易时间', '交易付款时间', '交易创建时间']));
    let payee = at(row, col(headers, ['商户名称', '交易对方']));
    const goods = at(row, col(headers, ['交易说明', '商品说明']));
    const dir = directionOf(at(row, col(headers, ['收/支'])));
    let status = at(row, col(headers, ['交易状态']));
    const account = at(row, col(headers, ['收/付款方式', '付款方式'])) || '京东';
    let category = at(row, col(headers, ['交易分类']));
    let id = at(row, col(headers, ['交易订单号']));
    let merchantId = at(row, col(headers, ['商家订单号', '商户订单号']));
    let remark = at(row, col(headers, ['备注']));
    const amountText = at(row, col(headers, ['金额']));
    const refundMark = amountMark(amountText);
    if (refundMark) remark = [remark, refundMark].filter(Boolean).join(' ');
    const aggregated = wechatGoodsAggregated(goods);
    const described = aggregated ? wechatField(goods, '商品描述') : goods;
    if (aggregated) {
      payee = payee || wechatField(goods, '交易对方');
      status = status || wechatField(goods, '状态');
      category = category || wechatField(goods, '交易类型');
      id = id || wechatField(goods, '京东交易单号');
      merchantId = merchantId || wechatField(goods, '商户订单号');
      remark = remark || wechatField(goods, '备注');
    }
    const flow = flowOf({ kind: `${payee} ${described}`, status, dir, accountName: account, payee });
    const note = jdNote({ category, payee, goods: described, status, id, merchantId, remark, payMethod: account });
    return {
      occurredAt: parseDateTime(time),
      type: flow.type,
      incoming: false,
      amountCents: yuanToCents(amountText),
      categoryName: categoryFor(flow.type, `${payee} ${described} ${remark}`, category, /转账/.test(`${payee} ${described}`) ? '转账' : '其他'),
      accountName: flow.accountName || account,
      toAccountName: flow.type === 'transfer' ? (flow.toAccountName || '') : '',
      payee,
      note,
      externalId: id,
      skipReason: flow.skipReason,
    };
  });
}

export function parseQianji(matrix) {
  return parseCommon(matrix, (headers, row) => {
    const time = at(row, col(headers, ['时间', '日期']));
    const category = at(row, col(headers, ['分类', '一级分类']));
    const sub = at(row, col(headers, ['二级分类']));
    const rawType = at(row, col(headers, ['类型']));
    const dir = directionOf(rawType);
    let amount = yuanToCents(at(row, col(headers, ['金额'])));
    const coupon = yuanToCents(at(row, col(headers, ['优惠券']))) || 0;
    if (amount != null && coupon > 0 && dir.type === 'expense') amount = Math.max(0, amount - coupon);
    const mark = at(row, col(headers, ['账单标记']));
    const noteBits = [at(row, col(headers, ['备注']))];
    if (coupon > 0) noteBits.push(`优惠券 ${coupon / 100}`);
    if (rawType === '报销') noteBits.unshift('报销');
    const accountName = at(row, col(headers, ['账户1', '账户']));
    const toAccountName = at(row, col(headers, ['账户2', '转入账户']));
    const payee = at(row, col(headers, ['商家', '交易对方']));
    const markedNeutral = mark.includes('不计收支') || /不计/.test(rawType);
    const flow = flowOf({
      kind: rawType, status: mark, dir, accountName, toAccountName, payee,
    });
    const type = markedNeutral && flow.type !== 'income' ? 'transfer' : flow.type;
    return {
      occurredAt: parseDateTime(time),
      type,
      incoming: false,
      amountCents: amount,
      categoryName: type === 'transfer' ? '' : (category || categoryFor(type, `${payee} ${noteBits.join(' ')}`, '', /转账/.test(rawType) ? '转账' : '其他')),
      subcategoryName: sub && sub !== category ? sub : '',
      accountName: type === 'transfer' && flow.accountName && !markedNeutral ? flow.accountName : accountName,
      toAccountName: type === 'transfer' ? (flow.toAccountName || toAccountName) : '',
      payee,
      note: noteBits.filter(Boolean).join(' '),
      externalId: '',
      skipReason: markedNeutral ? null : flow.skipReason,
    };
  });
}

// member 是出游/家庭账本里的「付款人」，只在共享账本用得上，普通账单没有这一列
const FIELD_ALIASES = {
  date: ['时间', '日期', '交易时间', '付款时间'],
  amount: ['金额', '金额(元)', '费用', '费用(元)', '消费金额'],
  type: ['类型', '收/支'],
  category: ['分类', '一级分类', '交易分类', '费用类型', '类别'],
  subcategory: ['二级分类'],
  account: ['账户', '账户1', '支付方式', '收/付款方式'],
  toAccount: ['账户2', '转入账户'],
  payee: ['交易对方', '对方', '商户名称', '商家', '费用详情', '项目'],
  note: ['备注', '商品', '商品说明', '交易说明', '说明', '详情'],
  externalId: ['交易单号', '交易订单号', '交易号', '单号'],
  member: ['付款人', '成员', '谁付的', '付款方', '报销人'],
  // 分摊人：这笔钱摊给谁。空 = 按账本参与人平分；「自己」= 请客，不算 AA
  share: ['分摊人', '参与人', '平摊人', '共同消费人', '谁一起', 'AA人'],
};

// 「胡胡、楠楠」→ ['胡胡','楠楠']；空 → null（全员平摊）；「自己」→ []（自己承担）
function parseShareNames(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^(自己|无|不分摊|自付)$/.test(raw)) return [];
  const names = raw.split(/[,，、;；\/|]+/).map((item) => item.trim()).filter(Boolean);
  return names.length ? [...new Set(names)] : null;
}

function normKey(alias) {
  return alias.replace(/\s/g, '').replace(/（元）|\(元\)/g, '');
}

// 先按完全相等占列，再按包含关系补剩下的字段。
// 不分两轮的话，「费用」会把「费用类型」那一列抢走，金额和分类就撞在同一列上。
export function suggestMapping(headers) {
  const norm = headers.map(normHeader);
  const taken = new Set();
  const mapping = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const keys = aliases.map(normKey);
    const i = norm.findIndex((h, index) => !taken.has(index) && keys.includes(h));
    if (i >= 0) {
      mapping[field] = headers[i];
      taken.add(i);
    }
  }
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (mapping[field]) continue;
    const keys = aliases.map(normKey);
    let best = -1;
    let bestLength = Infinity;
    norm.forEach((h, index) => {
      if (taken.has(index) || !h) return;
      if (!keys.some((k) => h.includes(k) || k.includes(h))) return;
      if (h.length < bestLength) {
        best = index;
        bestLength = h.length;
      }
    });
    if (best >= 0) {
      mapping[field] = headers[best];
      taken.add(best);
    }
  }
  return mapping;
}

export function parseCustom(matrix, mapping = {}) {
  const { headers, rows } = dataRows(matrix);
  const idx = {};
  for (const field of Object.keys(FIELD_ALIASES)) {
    idx[field] = mapping[field] ? headers.findIndex((h) => h === mapping[field]) : -1;
  }
  if (idx.date < 0 || idx.amount < 0) {
    throw new ImportError('自定义账单至少要映射「时间」和「金额」');
  }
  const expenseValues = mapping.expenseValues || ['支出', '支'];
  const incomeValues = mapping.incomeValues || ['收入', '收'];
  const transferValues = mapping.transferValues || ['转账', '还款'];
  return rows.map((row) => {
    const rawType = at(row, idx.type);
    // 空字符串会被 directionOf 当成「不计收支」的转账，所以没有这一列时直接按默认类型走
    let parsed = rawType
      ? directionOf(rawType)
      : { type: mapping.defaultType || (idx.type < 0 ? 'expense' : null) };
    if (!parsed.type && !parsed.skip && rawType) {
      if (expenseValues.includes(rawType)) parsed = { type: 'expense' };
      else if (incomeValues.includes(rawType)) parsed = { type: 'income' };
      else if (transferValues.includes(rawType)) parsed = { type: 'transfer' };
    }
    // 出游账本这类表格没有「收/支」列，没映射 type 就默认按支出记，否则整表都会被跳过
    if (!parsed.type && !parsed.skip) parsed = { type: mapping.defaultType || (idx.type < 0 ? 'expense' : null) };
    const accountName = at(row, idx.account);
    const toAccountName = at(row, idx.toAccount);
    const payee = at(row, idx.payee);
    const note = at(row, idx.note);
    const memberName = at(row, idx.member);
    const shareWith = parseShareNames(at(row, idx.share));
    // 表里没有「收/支」列时（出游账本就是），别走转账推断：
    // 那套逻辑靠 kindText 判断，空字符串会被当成转账，整表都记不成支出
    const flow = rawType
      ? flowOf({
        kind: rawType, status: '', dir: parsed, accountName, toAccountName, payee,
      })
      : { type: parsed.type, skipReason: null, accountName: '' };
    let type = flow.type || parsed.type;
    // 负数金额当成退款：金额取绝对值，支出改记收入（退票、退押金就是这么记的）
    let amountCents = yuanToCents(at(row, idx.amount));
    if (amountCents != null && amountCents < 0) {
      amountCents = Math.abs(amountCents);
      if (type === 'expense') type = 'income';
    }
    const categoryText = at(row, idx.category);
    // 认得出的分类走统一分类体系；认不出的（出游账本的「玩拼豆」「外带螃蟹」这类）
    // 原样留在分类标签上，否则全被并进「其他」，看不出钱花在哪
    const knownCategory = type === 'transfer' ? null : resolveCategoryPath(categoryText, type);
    return finalize({
      occurredAt: parseDateTime(at(row, idx.date)),
      type,
      amountCents,
      categoryName: knownCategory ? categoryFor(type, note, categoryText, /转账/.test(rawType) ? '转账' : '其他') : '',
      categoryLabel: knownCategory ? '' : categoryText,
      subcategoryName: at(row, idx.subcategory),
      accountName: flow.accountName || accountName,
      toAccountName: (flow.type || parsed.type) === 'transfer' ? (flow.toAccountName || toAccountName) : '',
      memberName,
      payee,
      note,
      shareWith,
      externalId: at(row, idx.externalId),
      skipReason: flow.skipReason || parsed.skip || null,
    });
  });
}

export function detectSource(headers, filename = '') {
  const h = headers.map(normHeader).join('|');
  const name = filename || '';
  if (h.includes('交易时间') && h.includes('交易单号') && (h.includes('商品') || h.includes('当前状态'))) return 'wechat';
  if (h.includes('资金状态') || (h.includes('交易号') && h.includes('付款时间'))) return 'alipay';
  if (h.includes('商品说明') && h.includes('交易分类')) return 'alipay';
  if (/钱迹|qianji/i.test(name) || (h.includes('账户1') && h.includes('类型'))) return 'qianji';
  if (/京东/i.test(name) || (h.includes('交易说明') && h.includes('收/支') && h.includes('商户名称'))) return 'jd';
  return 'custom';
}

function fixCmbWeirdChars(text) {
  if (!text) return text;
  return text
    .replace(/北京扩列䤯技有斮公司/g, '北京扩列科技有限公司')
    .replace(/北京瑞地䤯技有斮公司/g, '北京瑞地科技有限公司')
    .replace(/支付宝-溢棷敟火摣/g, '支付宝-消费')
    .replace(/支付宝-消岗/g, '支付宝-消费')
    .replace(/支付宝-?特丄商户/g, '支付宝特约商户')
    .replace(/支付宝-侲动优势䤯技/g, '支付宝-联动优势科技')
    .replace(/支付宝-天弘基愯䫿理/g, '支付宝-天弘基金管理')
    .replace(/支付宝-囫彸基愯䫿理/g, '支付宝-余额宝基金管理')
    .replace(/天弘基愯䫿理/g, '天弘基金管理')
    .replace(/囫彸基愯䫿理/g, '余额宝基金管理')
    .replace(/侲动优势䤯技/g, '联动优势科技')
    .replace(/待清䫵电子交换汇差-亯侲 待清䫵岢愯-借嬎卡核䫵专 户/g, '待清算电子交换汇差-网联 待清算商户-借记卡核心专户')
    .replace(/待清䫵岢愯-借嬎卡核䫵专 户/g, '待清算商户-借记卡核心专户')
    .replace(/待清䫵电子交换汇差-亯侲/g, '待清算电子交换汇差-网联')
    .replace(/借嬎卡核䫵专 户/g, '借记卡核心专户')
    .replace(/待清䫵代扣代付岢愯-他垪/g, '待清算代扣代付商户-他行')
    .replace(/待清䫵信用卡岢愯/g, '待清算信用卡商户')
    .replace(/待清䫵电子交换汇差/g, '待清算电子交换汇差')
    .replace(/岀付彸支付䤯技有斮公司/g, '财付通支付科技有限公司')
    .replace(/彸侲支付亯为服务俿份有斮 公司/g, '微信支付华为服务股份有限公司')
    .replace(/彸侲支付亯为服务俿份有斮/g, '微信支付华为服务股份有限公司')
    .replace(/南京刭宁易付宝亯为䤯技有 斮公司/g, '南京苏宁易付宝华为科技有限公司')
    .replace(/支付宝濝中国濞亯为技术有斮公/g, '支付宝(中国)网络技术有限公')
    .replace(/支付宝濝中 国濞亯为技术有斮公/g, '支付宝(中国)网络技术有限公')
    .replace(/国濞亯为技术有斮公/g, '国网络技术有限公')
    .replace(/支付宝外恆商户/g, '支付宝外包商户')
    .replace(/支付宝天弘基愯䫿理/g, '支付宝天弘基金管理')
    .replace(/有斮公司/g, '有限公司')
    .replace(/斮公司/g, '限公司')
    .replace(/基愯申岋/g, '基金申购')
    .replace(/基愯岬回/g, '基金赎回')
    .replace(/待廊岋买开放式基愯款柗-/g, '待购买开放式基金款项-')
    .replace(/待清䫵嬟券及基愯款柗/g, '待清算证券及基金款项')
    .replace(/亯上代发代扣/g, '网上代发代扣')
    .replace(/代发工岢/g, '代发工资')
    .replace(/亯上支付消岗濡易宝/g, '网上支付消费易宝')
    .replace(/亯上支付消岗濡彸侲/g, '网上支付消费微信')
    .replace(/亯侲收款/g, '网联收款')
    .replace(/摔侲代付/g, '银联代付')
    .replace(/摔侲交易岢愯/g, '银联交易商户')
    .replace(/摔侲丝上有卡支付/g, '银联线上有卡支付')
    .replace(/摔侲无卡先助消岗/g, '银联无卡自助消费')
    .replace(/交彸一卡彸有斮公司/g, '交通一卡通有限公司')
    .replace(/卡彸/g, '卡通')
    .replace(/濝特丄濞爱农槝/g, '宝贝爱上农场')
    .replace(/濝特丄濞浦发摔垪/g, '宝贝浦发银行')
    .replace(/濝特丄濞小䯑支付/g, '宝贝小额支付')
    .replace(/濝商户清丱䫵濞/g, '宝贝商户清算账')
    .replace(/濝商户清/g, '宝贝商户清')
    .replace(/岀付彸-微信廊岄/g, '财付通-微信支付')
    .replace(/岀付彸/g, '财付通')
    .replace(/丱䫵濞/g, '账算')
    .replace(/岄户丱息/g, '账户利息')
    .replace(/嬎岄日期/g, '交易日期')
    .replace(/岅币/g, '货币')
    .replace(/交易愯査/g, '交易金额')
    .replace(/侲机余査/g, '联机余额')
    .replace(/交易摘壟/g, '交易摘要')
    .replace(/客户摘壟/g, '客户摘要')
    .replace(/现愯岕弶款/g, '现金还款')
    .replace(/信用卡弶款/g, '信用卡还款')
    .replace(/待清䫵代扣代付岢愯/g, '待清算代扣代付商户')
    .replace(/摔垪卡䙒付/g, '银行卡支付')
    .replace(/摔垪俿份有斮公司/g, '银行股份有限公司')
    .replace(/国濞有斮公司刭州分/g, '国有限公司苏州分')
    .replace(/三方代理一卡彸扣/g, '三方代理一卡通')
    .replace(/方支付公司代扣清䫵/g, '方支付公司代扣清算')
    .replace(/支付宝廊岄提现/g, '支付宝提现')
    .replace(/余査宝提现/g, '余额宝提现')
    .replace(/余査宝/g, '余额宝')
    .replace(/岄户/g, '账户')
    .replace(/丱息/g, '利息')
    .replace(/一包/g, '红包')
    .replace(/曀对曀/g, '面对面')
    .replace(/摔垪/g, '银行')
    .replace(/濝中/g, '（中')
    .replace(/国濞/g, '国）')
    .replace(/倿仕广报摞廄岗/g, '胡仕广报销到岗')
    .replace(/䙒付彸在双向䯙商户/g, '直付通在双向类商户')
    .replace(/代发款柗/g, '代发款项')
    .replace(/倿/g, '胡')
    .replace(/濝对䤟濞/g, '资金清算')
    .replace(/先动嫿提/g, '自动计提')
    .replace(/利息濯/g, '利息税')
    .replace(/扣䥬濯/g, '扣税')
    .replace(/清䫵摔嬟濝基濞彸款柗/g, '清算银联宝贝额款项')
    .replace(/濝新\)/g, '新)')
    .replace(/廊岄/g, '提现')
    .replace(/交彸/g, '交通')
    .replace(/愫庆/g, '重庆')
    .replace(/䪊三/g, '第三')
    .replace(/濡/g, '与')
    .replace(/彽位/g, '微信')
    .replace(/摔侲ATM取款/g, '银联ATM取款')
    .replace(/消岗/g, '消费')
    .replace(/现愯/g, '现金')
    .replace(/弶款/g, '还款')
    .replace(/岕/g, '卡');
}

function parseCmbPdf(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const dataLines = [];
  for (const line of lines) {
    if (/^\d+\/\d+$/.test(line)) continue;
    if (/^\d{4}-\d{2}-\d{2}\s+--/.test(line)) continue;
    if (['招商银行交易流水', 'Transaction Statement of China Merchants Bank',
         'Name', 'Account Type', 'Date', 'Account No', 'Sub Branch', 'Verification Code'].includes(line)) continue;
    if (line.startsWith('户') && line.includes('名')) continue;
    if (line.startsWith('账户类型') || line.startsWith('申请时间') || line.startsWith('账号')) continue;
    if (line.startsWith('开 户 行') || line.startsWith('验 证 码')) continue;
    if (line === '记账日期 货币 交易金额 联机余额 交易摘要 对手信息 客户摘要') continue;
    if (line.includes('Date Currency Transaction') && line.includes('Amount Balance Transaction Type')) continue;
    if (line === 'Amount Balance Transaction Type Counter Party Customer Type') continue;
    if (line === 'Counter Party Customer Type') continue;
    if (line === 'Transaction') continue;
    if (line === 'Date Currency Transaction') continue;
    if (line === 'Date Currency') continue;
    if (/^-- \d+ of \d+ --/.test(line)) continue;
    if (/^—+$/.test(line)) continue; // 分隔线
    if (line.startsWith('温馨提示')) break;
    dataLines.push(line);
  }

  const recordsRaw = [];
  let current = null;
  for (const line of dataLines) {
    if (/^\d{4}-\d{2}-\d{2}\s/.test(line)) {
      if (current) recordsRaw.push(fixCmbWeirdChars(current));
      current = line;
    } else if (current) {
      // 招商银行 PDF 中 "财付通-微信支付-单字" 常被截断到下一行，需直接拼接
      if (/[-—][\u4e00-\u9fff]$/.test(current)) {
        current += line;
      } else {
        current += ' ' + line;
      }
    }
  }
  if (current) recordsRaw.push(fixCmbWeirdChars(current));

  const KNOWN_SUMMARIES = [
    '代发工资', '信用卡还款', '支付宝转账提现',
    '直付通在双向类商户 的交易（买卖）', '账户结息', '银联消费',
  ];
  const COUNTERPARTY_MARKERS = [
    '直付通交易清算内部户', '待清算信用卡资金',
    '其他应收款-支付宝资金清 算业务专用（对私）',
    '应付利息-应付个人活期存 款利息(自动计提)（新)',
    '待清算中间业务平台直付通 业务资金',
  ];

  const rows = [];
  for (const raw of recordsRaw) {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(CNY)\s+([-\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(.*)$/);
    if (!m) continue;
    const [, date, , amountStr, , rest] = m;
    const amount = parseFloat(amountStr.replace(/,/g, ''));
    const txType = amount > 0 ? 'income' : 'expense';

    let summary = '';
    let remaining = rest;
    for (const ks of KNOWN_SUMMARIES) {
      if (remaining.startsWith(ks)) {
        summary = ks;
        remaining = remaining.slice(ks.length).trim();
        break;
      }
    }
    if (!summary) {
      const parts = remaining.split(' ');
      summary = parts[0] || '';
      remaining = parts.slice(1).join(' ');
    }

    let counterparty = '';
    let customer = '';
    for (const marker of COUNTERPARTY_MARKERS) {
      const idx = remaining.indexOf(marker);
      if (idx >= 0) {
        const before = remaining.slice(0, idx).trim();
        const after = remaining.slice(idx + marker.length).trim();
        counterparty = marker.replace(/\s+/g, ' ');
        customer = after;
        if (before) summary += ' ' + before;
        break;
      }
    }

    if (!counterparty) {
      const idx = remaining.indexOf('有限公司');
      if (idx >= 0) {
        const endIdx = idx + 4;
        counterparty = remaining.slice(0, endIdx).trim();
        customer = remaining.slice(endIdx).trim();
      } else {
        const parts = remaining.split(' ');
        if (parts.length >= 2) {
          counterparty = parts.slice(0, -1).join(' ');
          customer = parts[parts.length - 1];
        } else {
          counterparty = remaining;
        }
      }
    }

    summary = summary.replace(/\s+/g, ' ').trim();
    counterparty = counterparty.replace(/\s+/g, ' ').trim();
    customer = customer.replace(/\s+/g, ' ').trim();

    let payee = counterparty;
    if (customer) {
      if (customer.includes('财付通') || customer.includes('支付宝')) payee = customer;
      else if (customer.includes('微信转账')) payee = '微信转账';
      else if (customer.includes('微信红包')) payee = '微信红包';
    }

    let note = summary;
    if (customer) note += ' | ' + customer;

    let categoryName = '';
    if (summary.includes('工资') || payee.includes('慧摩尔')) categoryName = '工资';
    else if (summary.includes('还款')) categoryName = '转账';
    else if (summary.includes('利息') || customer.includes('结息')) categoryName = '理财';
    else if (summary.includes('消费') || summary.includes('直付通')) categoryName = '购物';
    else if (summary.includes('提现')) categoryName = '转账';

    rows.push(blank({
      occurredAt: date,
      type: txType,
      amountCents: Math.round(Math.abs(amount) * 100),
      categoryName,
      accountName: '招商银行',
      toAccountName: '',
      payee,
      note,
      externalId: '',
      skipReason: null,
    }));
  }

  return rows.map(finalize);
}

const PARSERS = {
  wechat: parseWechat,
  alipay: parseAlipay,
  jd: parseJd,
  qianji: parseQianji,
};

export async function parseFile(buffer, filename, source, mapping) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) {
    const parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    const text = data.text || '';
    if (!text.includes('招商银行交易流水') && !text.includes('China Merchants Bank')) {
      throw new ImportError('不支持的PDF账单格式，目前仅支持招商银行交易流水PDF');
    }
    const rows = parseCmbPdf(text);
    return { needsMapping: false, source: 'cmb', headers: [], rows };
  }

  const matrix = loadTable(buffer, filename);
  const headerAt = findHeader(matrix);
  if (headerAt < 0) throw new ImportError('没有找到表头，请确认是导出的账单文件');
  const headers = matrix[headerAt].map(cleanCell);
  let resolved = source && source !== 'auto' ? source : detectSource(headers, filename);
  if (resolved === 'custom') {
    if (!mapping?.date || !mapping?.amount) {
      return {
        needsMapping: true,
        source: 'custom',
        headers,
        samples: matrix.slice(headerAt + 1, headerAt + 6).filter((r) => r.some(Boolean)),
        suggested: suggestMapping(headers),
      };
    }
    return { needsMapping: false, source: 'custom', headers, rows: parseCustom(matrix, mapping) };
  }
  const parser = PARSERS[resolved];
  if (!parser) throw new ImportError('不支持的账单来源');
  return { needsMapping: false, source: resolved, headers, rows: parser(matrix) };
}

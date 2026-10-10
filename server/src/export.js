import XLSX from 'xlsx';
import { centsToYuan } from './money.js';
import { parseShareWith } from './ledger.js';

const TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账' };
const SOURCE_LABEL = {
  manual: '手动记账',
  wechat: '微信账单',
  alipay: '支付宝账单',
  jd: '京东账单',
  qianji: '钱迹',
  recurring: '定期入账',
  custom: '自定义导入',
};

// 付款人/分摊人跟着一起导出，AA 账本才能导出后再原样导回来
export const EXPORT_HEADERS = ['时间', '类型', '金额', '分类', '二级分类', '账户1', '账户2', '商家', '备注', '付款人', '分摊人', '来源', '单号'];

export function exportMatrix(rows) {
  return rows.map((row) => {
    const parent = row.parent_name || row.category_name || '';
    const child = row.parent_name ? (row.category_name || '') : '';
    const shareWith = parseShareWith(row.share_with);
    return [
      row.occurred_at || '',
      TYPE_LABEL[row.type] || row.type || '',
      centsToYuan(row.amount_cents),
      parent,
      child,
      row.account_name || '',
      row.to_account_name || '',
      row.payee || '',
      row.note || '',
      row.member_name || '',
      // 没设过（全员平摊）留空，自己承担的写成「自己」，其余是名单
      shareWith === null ? '' : (shareWith.length ? shareWith.join('、') : '自己'),
      SOURCE_LABEL[row.source] || row.source || '',
      row.external_id || '',
    ];
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows) {
  const lines = [EXPORT_HEADERS, ...exportMatrix(rows)].map((line) => line.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function toXlsx(rows) {
  const sheet = XLSX.utils.aoa_to_sheet([EXPORT_HEADERS, ...exportMatrix(rows)]);
  sheet['!cols'] = EXPORT_HEADERS.map((header) => ({ wch: Math.max(header.length * 2, 12) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '账单');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

// 导入模板：下载后按列填好，再走「自定义」导入就能直接解析
const IMPORT_TEMPLATES = {
  // 出游/家庭账本：共享账本里记「谁付的」，导入后落在 member_name。
  // 分摊人决定这笔钱摊给谁：留空 = 按账本参与人平分，写「自己」= 请客不算 AA
  travel: {
    sheet: '出游账本',
    filename: '出游账本导入模板.xlsx',
    headers: ['付款人', '费用', '费用类型', '费用详情', '日期', '分摊人'],
    sample: [
      ['胡胡', 271, '吃饭', '葫芦岛-邴家小颖海鲜', '2026-10-02', '胡胡、楠楠、郭志华、李燕飞'],
      ['楠楠', 362, '住宿', '葫芦岛-住宿', '2026-10-02', '胡胡、楠楠、郭志华'],
      ['胡胡', 560, '加油', '葫芦岛-加油', '2026-10-03', ''],
      ['胡胡', 88, '请客', '请大家喝水', '2026-10-03', '自己'],
    ],
  },
  custom: {
    sheet: '账单',
    filename: '账单导入模板.xlsx',
    headers: ['日期', '金额', '收/支', '分类', '账户', '对方', '备注'],
    sample: [
      ['2026-10-02', 271, '支出', '餐饮', '微信', '某某餐厅', '和朋友吃饭'],
      ['2026-10-03', 5000, '收入', '工资', '银行卡', '公司', ''],
    ],
  },
};

export function importTemplate(kind) {
  const template = IMPORT_TEMPLATES[kind] || IMPORT_TEMPLATES.custom;
  const sheet = XLSX.utils.aoa_to_sheet([template.headers, ...template.sample]);
  sheet['!cols'] = template.headers.map((header) => ({ wch: Math.max(header.length * 2 + 4, 12) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, template.sheet);
  return { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), filename: template.filename };
}

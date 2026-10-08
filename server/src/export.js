import XLSX from 'xlsx';
import { centsToYuan } from './money.js';

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

export const EXPORT_HEADERS = ['时间', '类型', '金额', '分类', '二级分类', '账户1', '账户2', '商家', '备注', '来源', '单号'];

export function exportMatrix(rows) {
  return rows.map((row) => {
    const parent = row.parent_name || row.category_name || '';
    const child = row.parent_name ? (row.category_name || '') : '';
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

// 转账去向规则：账单里没有「对方账户」字段时，用它推断钱去了自己的哪个账户。
// 导入（importers.js）和存量修补（fix-transfers.js）共用这一份，两边逻辑不会跑偏。
// 顺序有意义：先匹配信用卡还款，再轮到其它。

const FIELDS = (f) => `${f.payee || ''} ${f.note || ''}`;

export const TRANSFER_LINK_RULES = [
  {
    label: '信用卡还款',
    target: '招商银行信用卡(3116)',
    match: (f) => /信用卡还款/.test(f.note || '') || /待清算信用卡/.test(f.payee || ''),
  },
  {
    label: '支付宝提现',
    target: '支付宝余额',
    match: (f) => /支付宝转账/.test(f.payee || '') || (/胡仕广/.test(f.payee || '') && /提现/.test(f.note || '')),
  },
  {
    label: '京东白条还款',
    target: '京东白条',
    match: (f) => /白条/.test(f.payee || ''),
  },
  {
    label: '花呗还款',
    target: '花呗',
    match: (f) => /花呗/.test(f.payee || ''),
  },
  {
    label: '网商银行',
    target: '网商银行储蓄卡(9869)',
    match: (f) => /网商银行/.test(f.payee || ''),
  },
  {
    label: '京东小金库',
    target: '京东小金库',
    match: (f) => /京东小金库|肯特瑞/.test(f.payee || ''),
  },
];

// 命中就返回 { label, target }，认不出来返回 null（交给调用方兜底）。
export function inferTransferTarget(fields) {
  const haystack = FIELDS(fields);
  if (!haystack.trim()) return null;
  for (const rule of TRANSFER_LINK_RULES) {
    if (rule.match(fields)) return rule;
  }
  return null;
}

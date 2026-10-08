export function amountMark(input) {
  const s = String(input ?? '').trim();
  const matched = s.match(/[(（]([^)）]+)[)）]\s*$/);
  if (!matched || !/\d/.test(s.slice(0, matched.index))) return '';
  return matched[1].trim();
}

export function yuanToCents(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s || s === '-' || s === '—') return null;
  const mark = amountMark(s);
  if (mark) s = s.slice(0, s.lastIndexOf(mark)).replace(/[(（]\s*$/, '').trim();
  s = s.replace(/[¥￥,\s]/g, '').replace(/元$/, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const digits = (frac + '000').slice(0, 3);
  let cents = Number(whole) * 100 + Number(digits.slice(0, 2));
  if (digits[2] >= '5') cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

export function centsToYuan(cents) {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(Number(cents) || 0);
  return `${sign}${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`;
}

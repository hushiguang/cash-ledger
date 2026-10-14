import { Children, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, apiUrl, getApiBase, setApiBase, getToken, setToken, subscribeBusy, track } from './api';
import { consumePayDraft, isNative, lastPayNotice, openPayAccessibilitySettings, openPayApp, openPayNotifySettings, openPayPopupSettings } from './platform';

const TYPES = [
  ['expense', '支出'],
  ['income', '收入'],
  ['transfer', '转账'],
];
const FREQS = [
  ['monthly', '每月'],
  ['weekly', '每周'],
  ['daily', '每天'],
  ['interval', '每隔几天'],
  ['yearly', '每年'],
];
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const ACCOUNT_KINDS = [
  ['cash', '现金'],
  ['wechat', '微信'],
  ['alipay', '支付宝'],
  ['bank', '银行卡'],
  ['jd', '京东'],
  ['other', '其他'],
];

function money(value, signed) {
  const n = Number(value || 0);
  const text = Math.abs(n).toFixed(2);
  if (!signed) return text;
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${text}`;
}

function nowLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function useSession() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    api('/api/me').then((data) => setUser(data.user)).catch(() => setToken('')).finally(() => setReady(true));
  }, []);
  return { user, setUser, ready };
}

// 顶部全局 loading：任何一个请求在飞就显示，不用每个页面各写一遍
function BusyBar() {
  const [busy, setBusy] = useState(0);
  useEffect(() => subscribeBusy(setBusy), []);
  if (!busy) return null;
  return (
    <div className="busy-bar" role="status" aria-live="polite">
      <span />
    </div>
  );
}

const THEME_KEY = 'qingji.theme';

function readTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

function applyTheme(theme) {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.resolved = theme === 'dark' || (theme === 'system' && dark) ? 'dark' : 'light';
}

function useTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(theme);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);
  return [theme, setTheme];
}

function optionText(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(optionText).join('');
  if (node.props) return optionText(node.props.children);
  return '';
}

/** 不用系统选择框。安卓弹出的是灰底单选，颜色跟账本对不上。 */
function AppSelect({ value, onChange, disabled, required, children }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const [box, setBox] = useState(null);
  const options = [];
  function pushOption(child, group) {
    if (!child || child.type !== 'option') return;
    const raw = child.props.value;
    options.push({
      value: raw == null ? optionText(child.props.children) : String(raw),
      label: optionText(child.props.children),
      disabled: !!child.props.disabled,
      group,
    });
  }
  Children.forEach(children, (child) => {
    if (!child) return;
    if (child.type === 'optgroup') {
      Children.forEach(child.props.children, (option) => pushOption(option, child.props.label || ''));
      return;
    }
    pushOption(child, '');
  });
  const current = options.find((item) => item.value === String(value ?? ''));

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const upward = spaceBelow < 220 && spaceAbove > spaceBelow;
    const room = Math.max(160, (upward ? spaceAbove : spaceBelow) - 12);
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 16);
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
    setBox({
      left: Math.max(8, left),
      width,
      top: upward ? undefined : rect.bottom + 6,
      bottom: upward ? window.innerHeight - rect.top + 6 : undefined,
      maxHeight: Math.min(320, room),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  function pick(next) {
    setOpen(false);
    onChange?.({ target: { value: next } });
  }

  return (
    <div className={`app-select${open ? ' open' : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className="app-select-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((valueOpen) => !valueOpen)}
      >
        <span>{current ? current.label : '请选择'}</span>
        <span className="app-select-caret" aria-hidden="true">▾</span>
      </button>
      {required && (
        <input className="app-select-required" tabIndex={-1} aria-hidden="true" value={value ?? ''} required onChange={() => {}} />
      )}
      {open && createPortal(
        <>
          <button className="app-select-backdrop" type="button" aria-label="关闭选项" onClick={() => setOpen(false)} />
          <div
            className="app-select-menu"
            role="listbox"
            style={{ left: box?.left, width: box?.width, top: box?.top, bottom: box?.bottom, maxHeight: box?.maxHeight }}
          >
            {options.map((item, index) => (
              <div key={`${item.group}-${item.value}-${index}`}>
                {item.group && item.group !== options[index - 1]?.group && (
                  <div className="app-select-group">{item.group}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={item.value === String(value ?? '')}
                  className={`app-select-option${item.value === String(value ?? '') ? ' active' : ''}`}
                  disabled={item.disabled}
                  onClick={() => pick(item.value)}
                >
                  <span>{item.label}</span>
                  {item.value === String(value ?? '') && <span className="app-select-check" aria-hidden="true">✓</span>}
                </button>
              </div>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const options = [['system', '跟随系统'], ['light', '亮色'], ['dark', '暗色']];
  return (
    <div className="segment theme-switch" role="group" aria-label="颜色">
      {options.map(([value, label]) => (
        <button key={value} type="button" className={theme === value ? 'active' : ''} aria-pressed={theme === value} onClick={() => setTheme(value)}>{label}</button>
      ))}
    </div>
  );
}

const RefreshContext = createContext({ saved: 0, bump: () => {} });

function useRefresh() {
  return useContext(RefreshContext);
}

// 手机上真正滚动的是 .main，只锁 body 的话弹窗背后还能滑。
// 详情弹窗会锁两次，后一次记下的是已经锁上的 hidden。若按后记的值还原，关掉弹窗后整页就滑不动。
let scrollLocks = 0;
let scrollBody = '';
let scrollMains = [];
function lockPageScroll() {
  if (scrollLocks === 0) {
    scrollBody = document.body.style.overflow;
    scrollMains = [...document.querySelectorAll('.main')].map((el) => [el, el.style.overflow]);
    document.body.style.overflow = 'hidden';
    scrollMains.forEach(([el]) => { el.style.overflow = 'hidden'; });
  }
  scrollLocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks -= 1;
    if (scrollLocks > 0) return;
    scrollLocks = 0;
    document.body.style.overflow = scrollBody;
    scrollMains.forEach(([el, overflow]) => { el.style.overflow = overflow; });
    scrollMains = [];
  };
}

// 弹窗打开时锁住背景滚动：不锁的话滚轮会带着后面的页面一起动
function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    return lockPageScroll();
  }, [active]);
}

// 微信账单卡片上的「使用零钱支付」「使用招商银行信用卡(3116)支付」对到已有账户。
const PAY_ACCOUNT_NAMES = {
  零钱: '微信零钱',
  微信: '微信零钱',
  微信支付: '微信零钱',
  零钱通: '零钱通',
  余额: '支付宝余额',
  账户余额: '支付宝余额',
  支付宝: '支付宝余额',
  余额宝: '余额宝',
  花呗: '花呗',
  花呗分期: '花呗',
  招商银行: '招商银行储蓄卡(5568)',
  '招商银行(5568)': '招商银行储蓄卡(5568)',
  招商银行储蓄卡: '招商银行储蓄卡(5568)',
  '招商银行信用卡(3116)': '招商银行信用卡(3116)',
  招商银行信用卡: '招商银行信用卡(3116)',
};

function payMethodText(note) {
  const line = String(note || '').split('\n').map((item) => item.trim()).find((item) => /^支付方式[：:]/.test(item));
  if (!line) return '';
  return line.replace(/^支付方式[：:]/, '').replace(/^使用/, '').replace(/支付$/, '').replace(/[「」“”"']/g, '').replace(/（/g, '(').replace(/）/g, ')').trim();
}

function stripPayMethod(note) {
  return String(note || '').split('\n').filter((item) => !/^支付方式[：:]/.test(item.trim())).join('\n').trim();
}

function matchPayAccount(accounts, method) {
  const raw = String(method || '').trim();
  if (!raw) return null;
  const label = PAY_ACCOUNT_NAMES[raw] || raw;
  const list = (accounts || []).filter((item) => !item.archived);
  const pick = (name) => list.find((item) => item.name === name && !item.mergedInto) || list.find((item) => item.name === name);
  let hit = pick(label) || (label !== raw ? pick(raw) : null);
  if (!hit) {
    const tail = label.match(/\((\d{4})\)/);
    if (tail) {
      const credit = label.includes('信用卡');
      hit = list.find((item) => !item.mergedInto && item.name.includes(tail[1]) && item.name.includes('信用卡') === credit)
        || list.find((item) => item.name.includes(tail[1]) && item.name.includes('信用卡') === credit);
    }
  }
  if (hit?.mergedInto) return list.find((item) => item.id === hit.mergedInto) || hit;
  return hit || null;
}

function CreateBillModal({ open, seed, onClose, onSaved }) {
  const books = useBooks();
  useScrollLock(open);
  const [form, setForm] = useState(emptyBill);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState('');
  const appliedSeed = useRef(0);
  const filledAccountSeed = useRef(0);
  const shared = !!books.currentBook && books.currentBook.kind !== 'personal';
  useEffect(() => {
    if (!open) {
      if (appliedSeed.current) {
        appliedSeed.current = 0;
        filledAccountSeed.current = 0;
        setForm(emptyBill());
        setHint('');
      }
      return;
    }
    if (!seed?.id) return;
    const method = payMethodText(seed.note);
    const account = matchPayAccount(books.accounts, method);
    const from = seed.source === 'alipay' ? '支付宝' : '微信';
    const filled = ['金额'];
    if (seed.payee) filled.push(`对方「${seed.payee}」`);
    if (seed.occurredAt) filled.push('时间');
    if (account) filled.push(`账户「${account.name}」`);
    else if (method) filled.push(`支付方式「${method}」没对上账户`);
    else if (seed.note) filled.push('备注');
    const hintText = `已从${from}付款页填入${filled.join('、')}，确认后再保存。`;
    if (appliedSeed.current !== seed.id) {
      appliedSeed.current = seed.id;
      filledAccountSeed.current = account ? seed.id : 0;
      setError('');
      setForm((current) => ({
        ...emptyBill(),
        accountId: account ? String(account.id) : current.accountId,
        toAccountId: current.toAccountId,
        categoryId: current.categoryId,
        type: seed.type === 'income' ? 'income' : 'expense',
        amount: seed.amount || '',
        payee: seed.payee || '',
        note: account ? stripPayMethod(seed.note) : (seed.note || ''),
        occurredAt: seed.occurredAt || current.occurredAt || emptyBill().occurredAt,
      }));
      setHint(hintText);
      return;
    }
    if (!account || filledAccountSeed.current === seed.id) return;
    filledAccountSeed.current = seed.id;
    setForm((current) => ({
      ...current,
      accountId: String(account.id),
      note: current.note === (seed.note || '') ? stripPayMethod(seed.note) : current.note,
    }));
    setHint(hintText);
  }, [open, seed, books.accounts]);
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      // Esc 关掉弹窗；正在保存时不打断，免得请求还在跑弹窗先没了
      if (event.key === 'Escape' && !saving) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, saving, onClose]);
  if (!open) return null;

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api('/api/transactions', {
        method: 'POST',
        body: {
          ...form,
          bookId: books.currentBookId || null,
          accountId: form.accountId ? Number(form.accountId) : null,
          toAccountId: form.toAccountId ? Number(form.toAccountId) : null,
          categoryId: form.categoryId ? Number(form.categoryId) : null,
          images: imageList(form.images),
        },
      });
      setForm(emptyBill());
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal modal-wide modal-grow bill-edit bill-edit-form" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2>记一笔{books.currentBook ? ` · ${books.currentBook.name}` : ''}</h2>
        <div className="bill-edit-body">
          {hint && <p className="tiny muted">{hint}</p>}
          {isNative && seed?.source && (
            <button className="secondary" type="button" onClick={() => { void openPayApp(seed.source); }}>
              {seed.source === 'alipay' ? '去支付宝识别详情' : '去微信识别详情'}
            </button>
          )}
          {error && <div className="error">{error}</div>}
          {shared ? (
            <SharedBillFields
              form={form}
              setForm={setForm}
              accounts={books.accounts}
              categories={books.categories}
              participants={bookPeopleNames(books.currentBook)}
              requireMember={bookAaOn(books.currentBook)}
            />
          ) : (
            <BookFields form={form} setForm={setForm} accounts={books.accounts} categories={books.categories} showImages />
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>取消</button>
          <button className="primary" type="submit" disabled={saving}>{saving ? '保存中…' : '记一笔'}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

const ICONS = {
  home: ['M3 9.5 12 3l9 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 20z', 'M9.5 21.5V12h5v9.5'],
  calendar: ['M4 5h16v16H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.6 6h.01', 'M3.6 12h.01', 'M3.6 18h.01'],
  repeat: ['M17 2l4 4-4 4', 'M3 12V9a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 12v3a4 4 0 0 1-4 4H3'],
  download: ['M12 3v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  wallet: ['M3 6h18v13H3z', 'M3 10h18', 'M16 14.5h2'],
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2.6 12.6V3.5h9.1l8.9 8.9a2 2 0 0 1 0 2.8z', 'M7 7h.01'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  book: ['M5 3h15v18H5z', 'M5 3a2.5 2.5 0 0 0 0 18', 'M9.5 7h6', 'M9.5 11h6'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M22 21v-2a4 4 0 0 0-3-3.9', 'M16 3.2a4 4 0 0 1 0 7.6'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8'],
  grid: ['M4 4h6.5v6.5H4z', 'M13.5 4H20v6.5h-6.5z', 'M4 13.5h6.5V20H4z', 'M13.5 13.5H20V20h-6.5z'],
  share: ['M14 5h5v5', 'M19 5l-8 8', 'M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5'],
  wrench: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
};

function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(ICONS[name] || []).map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

function navGroups(isAdmin) {
  const groups = [
    { title: '记账', items: [['/', '总览', 'home'], ['/calendar', '日历', 'calendar'], ['/bills', '账单', 'list'], ['/recurring', '定期', 'repeat']] },
    { title: '整理', items: [['/import', '导入', 'download'], ['/accounts', '账户', 'wallet'], ['/categories', '分类', 'tag'], ['/duplicates', '查重', 'copy'], ['/transfer-rules', '转账规则', 'repeat'], ['/cmb-fixes', '招行乱码', 'wrench']] },
    { title: '协作', items: [['/books', '账本', 'book']] },
  ];
  if (isAdmin) groups[2].items.push(['/users', '用户', 'users']);
  return groups;
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash % 360);
  return `hsl(${hue} 70% 55%)`;
}

function BookSwitch({ books, currentBookId, onChange }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { reload } = useBooks();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hint, setHint] = useState('');
  const [sharingId, setSharingId] = useState(0);
  useScrollLock(open);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const mine = books.filter((book) => !book.archived || book.id === currentBookId);
  const current = mine.find((book) => book.id === currentBookId) || mine[0];
  const filtered = mine.filter((book) => book.name.toLowerCase().includes(q.toLowerCase()));
  if (!mine.length) return null;

  // 没开分享：先开成只读再复制。已经开着：直接复制，不关掉。
  // 复制必须在这次点击里发起，等接口回来再写剪贴板，手机上会失败。
  async function shareBook(book, event) {
    event.stopPropagation();
    event.preventDefault();
    const canManage = book.role === 'owner' || book.role === 'admin';
    if (book.shareEnabled && book.shareToken) {
      const link = shareUrl(book.shareToken);
      const ok = await copyText(link);
      setHint(ok ? '链接已复制' : link);
      return;
    }
    if (!canManage) return;
    setSharingId(book.id);
    setHint('');
    const pending = (async () => {
      const result = await api(`/api/books/${book.id}/share`, {
        method: 'POST',
        body: { enabled: true, writable: false },
      });
      await reload();
      return shareUrl(result.book.shareToken);
    })();
    let copied = false;
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const item = new ClipboardItem({
          'text/plain': pending.then((link) => new Blob([link], { type: 'text/plain' })),
        });
        await navigator.clipboard.write([item]);
        copied = true;
      }
    } catch {
      copied = false;
    }
    try {
      const link = await pending;
      if (!copied) copied = await copyText(link);
      setHint(copied ? '链接已复制' : link);
    } catch (err) {
      setHint(err.message);
    } finally {
      setSharingId(0);
    }
  }

  async function toggleShareMode(book, event) {
    event.stopPropagation();
    event.preventDefault();
    if (book.role !== 'owner' && book.role !== 'admin') return;
    setSharingId(book.id);
    setHint('');
    try {
      const writable = !book.shareWritable;
      await api(`/api/books/${book.id}/share`, { method: 'POST', body: { enabled: true, writable } });
      await reload();
      setHint(writable ? '分享已改为可编辑' : '分享已改为只读');
    } catch (err) {
      setHint(err.message);
    } finally {
      setSharingId(0);
    }
  }

  return (
    <div className="book-picker">
      <button className="book-current" type="button" onClick={() => { setOpen(true); setQ(''); }} title="切换账本">
        <span className="book-avatar" style={{ background: stringToColor(current?.name || '') }}>{current?.name.slice(0, 1)}</span>
        <span className="book-meta">
          <b>{current?.name}</b>
          <span className="tiny muted">{current?.kindLabel}{current?.role && current.role !== 'owner' ? ` · ${current.ownerName}` : ''}</span>
        </span>
        <span className="book-caret">▾</span>
      </button>
      {open && createPortal(
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal book-switch-modal stack"
            role="dialog"
            aria-modal="true"
            aria-label="切换账本"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>切换账本</h2>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索账本…"
              autoFocus={window.matchMedia('(min-width: 901px)').matches}
            />
            {hint && <p className="tiny muted book-switch-hint">{hint}</p>}
            <div className="book-switch-list">
              {filtered.map((book) => {
                const canManage = book.role === 'owner' || book.role === 'admin';
                const canShare = book.kind !== 'personal' && (canManage || book.shareEnabled);
                const modeLabel = book.shareWritable ? '可编辑' : '只读';
                return (
                  <div
                    key={book.id}
                    role="button"
                    tabIndex={0}
                    className={`book-switch-item${book.id === currentBookId ? ' active' : ''}${book.shareEnabled ? ' has-share' : ''}`}
                    // 换完账本就关掉弹窗，并回到总览：留在原页面的话，看到的是新账本下的旧筛选
                    onClick={() => { onChange(book.id); setOpen(false); navigate('/'); }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onChange(book.id);
                      setOpen(false);
                      navigate('/');
                    }}
                  >
                    <span className="book-avatar" style={{ background: stringToColor(book.name) }}>{book.name.slice(0, 1)}</span>
                    <span className="book-meta">
                      <b>{book.name}</b>
                      <span className="tiny muted">
                        {book.kindLabel}
                        {book.role && book.role !== 'owner' ? ` · ${book.ownerName}` : ''}
                        {book.archived ? ' · 已归档' : ''}
                      </span>
                    </span>
                    {book.shareEnabled && (
                      canManage ? (
                        <button
                          type="button"
                          className="book-share-mark"
                          title={book.shareWritable ? '改成只读' : '改成可编辑'}
                          disabled={sharingId === book.id}
                          onClick={(event) => toggleShareMode(book, event)}
                        >
                          {modeLabel}
                        </button>
                      ) : <span className="book-share-mark">{modeLabel}</span>
                    )}
                    <span className="book-switch-side">
                      {canShare && (
                        <button
                          type="button"
                          className={`book-share-btn${book.shareEnabled ? ' on' : ''}`}
                          title={book.shareEnabled ? '复制分享链接' : '开启只读分享并复制链接'}
                          disabled={sharingId === book.id}
                          onClick={(event) => shareBook(book, event)}
                        >
                          <Icon name="share" size={16} />
                        </button>
                      )}
                      {book.id === currentBookId ? <span className="book-check">✓</span> : <span className="tiny muted">切换</span>}
                    </span>
                  </div>
                );
              })}
              {!filtered.length && <p className="muted">没有匹配的账本</p>}
            </div>
            <div className="modal-actions">
              <NavLink className="ghost small" to="/books" onClick={() => setOpen(false)}>管理账本</NavLink>
              <button className="secondary" type="button" onClick={() => setOpen(false)}>关闭</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function Shell({ user, onLogout, onSaved, children }) {
  const [creating, setCreating] = useState(false);
  const [payDraft, setPayDraft] = useState(null);
  useEffect(() => {
    function openDraft(draft) {
      if (!draft?.amount || !draft.id) return;
      sessionStorage.removeItem('qingji.payDraft');
      setPayDraft(draft);
      setCreating(true);
    }
    function onDraft(event) {
      openDraft(event.detail);
    }
    window.addEventListener('qingji:payDraft', onDraft);
    const pending = consumePayDraft();
    if (pending) openDraft(pending);
    return () => window.removeEventListener('qingji:payDraft', onDraft);
  }, []);
  const { pathname } = useLocation();
  const books = useBooksSource();
  const { books: bookList, currentBookId, setCurrentBookId } = books;
  const groups = navGroups(user.isAdmin);
  const primary = groups[0].items;
  const moreItems = groups.slice(1).flatMap((group) => group.items);
  const userTabActive = pathname === '/me' || moreItems.some(([to]) => pathname === to);
  const showFab = pathname === '/' || pathname === '/calendar' || pathname === '/bills';
  return (
    <BooksContext.Provider value={books}>
      <div className={`app-shell${userTabActive ? ' app-shell-user' : ''}`}>
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand">轻账单<span className="brand-sub">LEDGER</span></div>
            <BookSwitch books={bookList} currentBookId={currentBookId} onChange={setCurrentBookId} />
          </div>
          <nav className="sidenav">
            {groups.map((group) => (
              <div className="nav-group" key={group.title}>
                <span className="nav-title">{group.title}</span>
                {group.items.map(([to, label, icon]) => (
                  <NavLink key={to} to={to} end={to === '/'}>
                    <Icon name={icon} />
                    <span>{label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-foot">
            <ThemeSwitch />
            <div className="me-row">
              <span className="me-avatar">{user.displayName.slice(0, 1)}</span>
              <span className="me-name" title={user.displayName}>{user.displayName}{user.isAdmin ? ' · 管理员' : ''}</span>
              <span className="spacer" />
              <button className="ghost" type="button" onClick={onLogout} title="退出">退出</button>
            </div>
          </div>
        </aside>
        {!userTabActive && (
          <header className="h5-bar">
            <div className="brand">轻账单</div>
            <BookSwitch books={bookList} currentBookId={currentBookId} onChange={setCurrentBookId} />
          </header>
        )}
        <main className="main">{children}</main>
        <nav className="h5-tabs" aria-label="主导航">
          {primary.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <Icon name={icon} size={22} />
              <span>{label}</span>
            </NavLink>
          ))}
          <NavLink to="/me" className={userTabActive ? 'active' : ''}>
            <Icon name="user" size={22} />
            <span>用户</span>
          </NavLink>
        </nav>
        {showFab && (
          <button className="fab" type="button" title="记一笔" aria-label="记一笔" onClick={() => setCreating(true)}>
            <span className="fab-plus">+</span>
          </button>
        )}
        <CreateBillModal open={creating} seed={payDraft} onClose={() => { setCreating(false); setPayDraft(null); }} onSaved={onSaved} />
      </div>
    </BooksContext.Provider>
  );
}

function useNarrow() {
  const query = '(max-width: 900px)';
  const get = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

function FormModal({ title, onClose, children }) {
  useScrollLock(true);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal stack" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body
  );
}

function UserPage({ user, onLogout }) {
  const groups = navGroups(user.isAdmin).slice(1);
  const [payHeard, setPayHeard] = useState('');
  useEffect(() => {
    if (!isNative) return undefined;
    let alive = true;
    void lastPayNotice().then((text) => { if (alive) setPayHeard(text); });
    return () => { alive = false; };
  }, []);
  return (
    <div className="page stack user-page">
      <div className="user-card">
        <span className="me-avatar">{user.displayName.slice(0, 1)}</span>
        <div className="user-card-name">
          <b>{user.displayName}</b>
          <span className="tiny muted">{user.isAdmin ? '管理员' : '成员'}</span>
        </div>
        <button className="ghost" type="button" onClick={onLogout}>退出</button>
      </div>
      <section className="user-menu" aria-label="外观">
        <h2>外观</h2>
        <ThemeSwitch />
      </section>
      {groups.map((group) => (
        <section className="user-menu" key={group.title} aria-label={group.title}>
          <h2>{group.title}</h2>
          {group.items.map(([to, label, icon]) => (
            <NavLink key={to} to={to} className="user-menu-item">
              <Icon name={icon} />
              <span>{to === '/users' ? '用户管理' : label}</span>
              <span className="user-menu-chevron" aria-hidden="true">›</span>
            </NavLink>
          ))}
        </section>
      ))}
      {isNative && (
        <section className="user-menu" aria-label="付款识别">
          <h2>付款识别</h2>
          <button className="user-menu-item" type="button" onClick={() => { void openPayNotifySettings(); }}>
            <span>允许读取付款通知</span>
            <span className="user-menu-chevron" aria-hidden="true">›</span>
          </button>
          <button className="user-menu-item" type="button" onClick={() => { void openPayAccessibilitySettings(); }}>
            <span>允许无障碍拉起</span>
            <span className="user-menu-chevron" aria-hidden="true">›</span>
          </button>
          <button className="user-menu-item" type="button" onClick={() => { void openPayPopupSettings(); }}>
            <span>允许后台弹出界面</span>
            <span className="user-menu-chevron" aria-hidden="true">›</span>
          </button>
          <p className="tiny muted">通知使用权负责读到「已支付」。无障碍里打开「轻账单付款通知」，付款后才会自动弹出记一笔。确认后才会保存。</p>
          {payHeard && <p className="tiny muted">最近读到：{payHeard}</p>}
        </section>
      )}
    </div>
  );
}

/**
 * 服务器地址：网页访问留空走同源；手机 App 是本地包，必须指向 NAS / 服务器才能请求。
 * 放在登录页是因为没配地址就连不上，登录后也能从侧栏「退出」旁边再改。
 */
function ServerSetup() {
  const [open, setOpen] = useState(() => isNative || Boolean(getApiBase()));
  const [url, setUrl] = useState(() => getApiBase());
  const [hint, setHint] = useState('');
  if (!open) {
    return (
      <button className="link-btn" type="button" onClick={() => setOpen(true)}>服务器地址</button>
    );
  }
  return (
    <div className="server-setup">
      <label>
        服务器地址
        <input
          value={url}
          onChange={(event) => { setUrl(event.target.value); setHint(''); }}
          placeholder="http://192.168.1.10:8080"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <div className="server-setup-actions">
        <button className="secondary" type="button" onClick={() => { setApiBase(url); setHint('已保存，重新登录生效'); }}>
          保存
        </button>
        <button className="link-btn" type="button" onClick={() => setOpen(false)}>收起</button>
      </div>
      {hint && <p className="muted">{hint}</p>}
      <p className="muted">手机 App 填 NAS / 服务器的地址（含端口）；网页访问留空。</p>
    </div>
  );
}

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [config, setConfig] = useState({ allowRegister: true, hasUsers: true });
  const [form, setForm] = useState({ username: '', password: '', displayName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/api/auth/config').then(setConfig).catch(() => {});
  }, []);
  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const data = await api(path, { method: 'POST', body: form });
      setToken(data.token);
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <div className="auth-theme"><ThemeSwitch /></div>
      <form className="card auth-card stack" onSubmit={submit}>
        <h1>轻账单</h1>
        <p className="muted">{mode === 'register' ? '创建账号后会带上常用账户和分类。' : '登录后记账、导入账单、查看日历。'}</p>
        {error && <div className="error">{error}</div>}
        <label>用户名<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
        {mode === 'register' && (
          <label>显示名<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
        )}
        <label>密码<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
        <button className="primary" type="submit" disabled={busy}>{busy ? (mode === 'register' ? '注册中…' : '登录中…') : (mode === 'register' ? '注册' : '登录')}</button>
        {config.allowRegister && (
          <button className="secondary" type="button" disabled={busy} onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? '没有账号，去注册' : '已有账号，去登录'}
          </button>
        )}
        <ServerSetup />
      </form>
    </div>
  );
}

const BOOK_KEY = 'qingji.book';
// 账本是全局状态：侧栏切换后，总览/日历/账单这些页面要跟着变，所以统一由 Shell 提供
const BooksContext = createContext(null);

function useBooksSource(enabled = true) {
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [books, setBooks] = useState([]);
  const [currentBookId, setCurrentBookId] = useState(() => Number(localStorage.getItem(BOOK_KEY)) || 0);
  const [ready, setReady] = useState(false);
  async function reload() {
    const [a, c, b] = await Promise.all([api('/api/accounts'), api('/api/categories'), api('/api/books')]);
    setAccounts(a.accounts);
    setCategories(c.categories);
    const list = b.books || [];
    setBooks(list);
    // 记住上次选的账本；没了就退回自己的个人账本
    setCurrentBookId((prev) => {
      if (prev && list.some((book) => book.id === prev)) return prev;
      const own = list.find((book) => book.kind === 'personal' && book.role === 'owner');
      return (own || list[0])?.id || 0;
    });
    setReady(true);
    // 把最新账本列表交给调用方：编辑弹窗要靠它刷新自己的数据
    return list;
  }
  useEffect(() => {
    if (!enabled) return;
    reload().catch(() => setReady(true));
  }, [enabled]);
  useEffect(() => {
    if (currentBookId) localStorage.setItem(BOOK_KEY, String(currentBookId));
  }, [currentBookId]);
  const currentBook = books.find((book) => book.id === currentBookId) || null;
  const bookQuery = currentBookId ? `bookId=${currentBookId}` : '';
  return { accounts, categories, books, currentBook, currentBookId, setCurrentBookId, bookQuery, reload, ready };
}

function useBooks() {
  const shared = useContext(BooksContext);
  const own = useBooksSource(!shared);
  return shared || own;
}

// 给查询串拼上账本参数：&bookId=1 或 ?bookId=1
function withBook(query, bookQuery) {
  if (!bookQuery) return query;
  return query ? `${query}&${bookQuery}` : `?${bookQuery}`;
}

function BookFields({ form, setForm, accounts, categories, showTime = true, showImages = false }) {
  const cats = categories.filter((c) => !c.archived && c.kind === form.type);
  return (
    <div className="form-row wrap">
      <label>类型
        <AppSelect value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, categoryId: '' })}>
          {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </AppSelect>
      </label>
      <label>金额<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
      {showTime && <label>时间<input type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} required /></label>}
      <label>{form.type === 'transfer' ? '转出账户' : '账户'}
        <AppSelect value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })} required>
          <option value="">请选择</option>
          {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </AppSelect>
      </label>
      {form.type === 'transfer' ? (
        <label>转入账户
          <AppSelect value={form.toAccountId} onChange={(e) => setForm({ ...form, toAccountId: e.target.value })} required>
            <option value="">请选择</option>
            {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </AppSelect>
        </label>
      ) : (
        <label>分类
          <AppSelect value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
            <option value="">未分类</option>
            {cats.filter((c) => !c.parentId).map((parent) => (
              <optgroup key={parent.id} label={parent.name}>
                <option value={parent.id}>{parent.name}</option>
                {cats.filter((c) => c.parentId === parent.id).map((child) => (
                  <option key={child.id} value={child.id}>{child.name}</option>
                ))}
              </optgroup>
            ))}
          </AppSelect>
        </label>
      )}
      <label className="field-full">对方<input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} /></label>
      <label className="field-full">备注<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      {showImages && (
        <div className="field-full">
          <span className="tiny muted">图片（选完自动传图床，最多 9 张）</span>
          <ImagePicker images={form.images} onChange={(images) => setForm({ ...form, images })} />
        </div>
      )}
    </div>
  );
}

// 图片：选文件直接传图床，缩略图走服务端代理（图床是自签证书，浏览器直连会加载失败）。
// App 的页面在本地，必须带上后端地址，否则缩略图请求会打到 WebView 自己身上。
function imageSrc(url) {
  return apiUrl(`/api/image?u=${encodeURIComponent(url || '')}`);
}

function ImageViewer({ src, onClose }) {
  useScrollLock(true);
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    function onBack(event) {
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', onKey);
    window.addEventListener('capacitor:back', onBack);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('capacitor:back', onBack);
    };
  }, [onClose]);
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label="查看图片" onClick={onClose}>
      <button className="image-viewer-close" type="button" onClick={onClose}>关闭</button>
      <img src={src} alt="" onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  );
}

function BillImage({ url }) {
  const [open, setOpen] = useState(false);
  const src = imageSrc(url);
  return (
    <>
      <img src={src} alt="" onClick={() => setOpen(true)} />
      {open && <ImageViewer src={src} onClose={() => setOpen(false)} />}
    </>
  );
}

function imageList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function ImagePicker({ images, onChange, uploadPath = '/api/upload/image', disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = Array.isArray(images) ? images : String(images || '').split('\n').map((s) => s.trim()).filter(Boolean);

  async function pick(event) {
    const files = [...event.target.files];
    event.target.value = '';
    if (!files.length) return;
    setBusy(true);
    setError('');
    try {
      const added = [];
      for (const file of files.slice(0, 9 - list.length)) {
        const body = new FormData();
        body.append('image', file);
        const result = await api(uploadPath, { method: 'POST', body });
        added.push(result.url);
      }
      onChange([...list, ...added]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="image-picker">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="file-btn">
          {busy ? '上传中…' : '选择图片'}
          <input type="file" accept="image/*" multiple onChange={pick} disabled={busy || disabled} hidden />
        </label>
        <span className="tiny muted">{list.length}/9，最多 9 张</span>
      </div>
      {error && <div className="error">{error}</div>}
      {list.length > 0 && (
        <div className="image-grid">
          {list.map((url) => (
            <span className="image-thumb" key={url}>
              <BillImage url={url} />
              <button type="button" className="chip-btn danger" title="移除" onClick={() => onChange(list.filter((item) => item !== url))}>✕</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// 共享/家庭账本用的简化表单：账户可留空，分类自己填（已有的会联想出来）。
// 开了 AA 的账本必填付款人/收款人（要拿它算平摊），没开的可以留空，只记账
function SharedBillFields({ form, setForm, accounts, categories, participants = [], showTime = true, requireMember = true }) {
  const names = [...new Set(categories.filter((c) => !c.archived && c.kind === form.type).map((c) => c.name))];
  // 账本预设的参与人，付款人直接选，免得同一个人打成两个名字、AA 算错
  const people = [...new Set(participants.map((item) => (typeof item === 'string' ? item : item.name)).filter(Boolean))];
  // 分摊人候选 = 预设名单 + 付款人自己（A 打车 A 自己也坐车，默认也要摊一份）
  const options = [...new Set([...people, ...(form.memberName ? [form.memberName.trim()] : [])])].filter(Boolean);
  // 没设过就默认全选；空数组 = 这笔不分摊给别人（请客 / 自己承担）
  const picked = Array.isArray(form.shareWith) ? form.shareWith : options;
  function toggleShare(name, on) {
    const next = on
      ? [...new Set([...picked, name])]
      : picked.filter((item) => item !== name);
    setForm({ ...form, shareWith: next });
  }
  function addPayerToShare(value) {
    const name = String(value || '').trim();
    if (!name || picked.includes(name)) return;
    setForm({ ...form, shareWith: [...picked, name] });
  }
  return (
    <div className="form-row wrap">
      <label>收支
        <AppSelect value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {[['expense', '支出'], ['income', '收入']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </AppSelect>
      </label>
      <label>金额<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
      {showTime && <label>时间<input type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} /></label>}
      <label>{form.type === 'income' ? '收款人' : '付款人'}
        <input
          list="book-participant-options"
          value={form.memberName}
          onChange={(e) => setForm({ ...form, memberName: e.target.value })}
          onBlur={(e) => addPayerToShare(e.target.value)}
          placeholder={requireMember ? '谁付的 / 谁收的' : '可留空'}
          required={requireMember}
        />
        <datalist id="book-participant-options">
          {people.map((name) => <option key={name} value={name} />)}
        </datalist>
      </label>
      <label>分类
        <input
          list="shared-category-options"
          value={form.categoryLabel}
          onChange={(e) => setForm({ ...form, categoryLabel: e.target.value })}
          placeholder="自己写，已有的会联想"
        />
        <datalist id="shared-category-options">
          {names.map((name) => <option key={name} value={name} />)}
        </datalist>
      </label>
      <label>账户（可留空）
        <AppSelect value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
          <option value="">不填</option>
          {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </AppSelect>
      </label>
      {requireMember && (
        <div className="field-full">
          <span className="tiny muted">分摊人员（一个都不勾 = 这笔自己承担）</span>
          <div className="checks share-picks">
            {options.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={picked.includes(name)}
                  onChange={(e) => toggleShare(name, e.target.checked)}
                />
                {name}
              </label>
            ))}
          </div>
        </div>
      )}
      <label className="field-full">标题 / 对方<input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} placeholder="账单列表里显示的标题" /></label>
      <label className="field-full">备注<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <div className="field-full">
        <span className="tiny muted">图片（选完自动传图床，最多 9 张）</span>
        <ImagePicker images={form.images} onChange={(images) => setForm({ ...form, images })} />
      </div>
    </div>
  );
}

function emptyBill() {
  return {
    type: 'expense',
    amount: '',
    occurredAt: nowLocal(),
    accountId: '',
    toAccountId: '',
    categoryId: '',
    categoryLabel: '',
    memberName: '',
    payee: '',
    note: '',
    images: [],
  };
}

function typeLabel(type) {
  return TYPES.find((item) => item[0] === type)?.[1] || '账单';
}

function signedMoney(tx) {
  const sign = tx.type === 'income' ? '+' : tx.type === 'expense' ? '-' : '';
  return `${sign}${money(tx.amount)}`;
}

function accountLine(tx) {
  if (tx.toAccountName && tx.toAccountName !== tx.accountName) return `${tx.accountName} → ${tx.toAccountName}`;
  return tx.accountName || '';
}

function billFlag(tx) {
  const note = String(tx.note || '');
  if (/对方已退还/.test(note) || (tx.type === 'transfer' && /已全额退款/.test(note))) return { kind: 'returned', label: '已退还' };
  if (tx.type !== 'transfer' || /收益发放|奖励发放|收益补贴/.test(note)) return null;
  const ownMove = tx.toAccountName && tx.toAccountName !== tx.accountName;
  const ownKind = /提现|零钱充值|零钱通|余额宝/.test(note);
  if (ownMove || ownKind) return { kind: 'self', label: '自己转账' };
  return null;
}

function billTitle(tx) {
  return tx.payee || tx.note || tx.categoryName || typeLabel(tx.type);
}

function formatWhen(value) {
  return String(value || '').replace('T', ' ').slice(0, 16);
}

function formatDay(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return `${year}年${month}月${day}日 周${'日一二三四五六'[date.getDay()]}`;
}

function groupByDay(rows) {
  const groups = [];
  for (const tx of rows) {
    const day = tx.occurredAt.slice(0, 10);
    const last = groups.at(-1);
    if (!last || last.day !== day) groups.push({ day, items: [tx] });
    else last.items.push(tx);
  }
  return groups;
}

const SOURCES = {
  manual: '手动记账',
  wechat: '微信账单',
  alipay: '支付宝账单',
  jd: '京东账单',
  qianji: '钱迹',
  cmb: '招商银行',
  recurring: '定期入账',
  custom: '自定义导入',
  shared: '共享补账',
};

// 账单列表每次拉多少条，「加载更多」按这个步长继续追加
const BILL_PAGE_SIZE = 500;

// 账单列表排序。空 = 按时间倒序（默认，按天分组）；其余按金额，不分组
const BILL_SORTS = [
  ['', '按时间'],
  ['amount_desc', '金额高→低'],
  ['amount_asc', '金额低→高'],
  ['amount_abs', '绝对值高→低'],
];

async function fetchExport(format, query = '') {
  const params = new URLSearchParams(String(query).replace(/^\?/, ''));
  params.set('format', format);
  const response = await track(fetch(apiUrl(`/api/export?${params}`), {
    headers: { Authorization: `Bearer ${getToken()}` },
  }));
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || '导出失败');
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('导出文件是空的');
  const disposition = response.headers.get('Content-Disposition') || '';
  const matched = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const filename = matched ? decodeURIComponent(matched[1]) : `轻账单.${format}`;
  return { blob, filename };
}

function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function ClearBills({ onClose, onCleared, currentBook, bookId, bookQuery }) {
  useScrollLock(true);
  const [text, setText] = useState('');
  const [count, setCount] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const scopeQuery = bookQuery ? `?${bookQuery}` : '';
  useEffect(() => {
    api(`/api/transactions/count${scopeQuery}`).then((data) => setCount(data.count)).catch((err) => setError(err.message));
  }, [scopeQuery]);
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  async function submit(event) {
    event.preventDefault();
    if (text.trim() !== '确认' || busy || !count) return;
    setBusy(true);
    setError('');
    try {
      const csv = await fetchExport('csv', scopeQuery);
      const xlsx = await fetchExport('xlsx', scopeQuery);
      saveFile(csv.blob, csv.filename);
      saveFile(xlsx.blob, xlsx.filename);
      await api('/api/transactions', { method: 'DELETE', body: { confirm: '确认', bookId } });
      onCleared();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  const ready = text.trim() === '确认' && count > 0 && !busy;
  return createPortal(
    <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <form className="modal stack" role="dialog" aria-modal="true" aria-labelledby="clear-title" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2 id="clear-title">清除账单</h2>
        <p className="muted">
          将删除{currentBook ? `「${currentBook.name}」里的` : ''}全部账单{count == null ? '' : `，共 ${count} 笔`}。删除前会先下载 CSV 和 Excel。账户、分类和定期规则会保留。
        </p>
        {error && <div className="error">{error}</div>}
        <label>输入「确认」后继续
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoFocus disabled={busy || count === 0} placeholder="确认" />
        </label>
        {busy && <p className="muted">正在导出 CSV 和 Excel，随后清除账单…</p>}
        <div className="modal-actions">
          <button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="danger" type="submit" disabled={!ready}>{busy ? '处理中' : '清除'}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function BillDetail({ tx, onClose, onDelete, onSave }) {
  const books = useBooks();
  useScrollLock(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const flag = billFlag(tx);
  const rows = [
    ['类型', [typeLabel(tx.type), flag?.label].filter(Boolean).join(' · ')],
    ['时间', formatWhen(tx.occurredAt)],
    ['账户', accountLine(tx)],
    ['分类', tx.categoryName || tx.categoryLabel],
    [tx.type === 'income' ? '收款人' : '付款人', tx.memberName],
    // 分摊人：没设过就是按账本参与人平分，空数组 = 这笔自己承担
    ...(bookAaOn(books.books.find((item) => item.id === tx.bookId))
      ? [['分摊', Array.isArray(tx.shareWith) ? (tx.shareWith.length ? tx.shareWith.join('、') : '自己承担') : '全员平摊']]
      : []),
    ['对方', tx.payee],
    ['备注', tx.note],
    ['来源', SOURCES[tx.source] || tx.source],
  ].filter(([, value]) => value);

  function startEdit() {
    setError('');
    setForm({
      type: tx.type,
      amount: String(tx.amount ?? ''),
      // datetime-local 只认 YYYY-MM-DDTHH:mm
      occurredAt: String(tx.occurredAt || '').slice(0, 16).replace(' ', 'T'),
      accountId: tx.accountId ? String(tx.accountId) : '',
      toAccountId: tx.toAccountId ? String(tx.toAccountId) : '',
      categoryId: tx.categoryId ? String(tx.categoryId) : '',
      categoryLabel: tx.categoryLabel || '',
      memberName: tx.memberName || '',
      payee: tx.payee || '',
      note: tx.note || '',
      images: imageList(tx.images),
      // 老账单是 null（全员平分），交给表单默认全选；空数组 = 自己承担
      shareWith: Array.isArray(tx.shareWith) ? tx.shareWith : undefined,
    });
    setEditing(true);
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api(`/api/transactions/${tx.id}`, {
        method: 'PATCH',
        body: {
          ...form,
          accountId: Number(form.accountId),
          toAccountId: form.toAccountId ? Number(form.toAccountId) : null,
          categoryId: form.categoryId ? Number(form.categoryId) : null,
          images: imageList(form.images),
        },
      });
      setEditing(false);
      // 后端是删掉重建，id 会变，交给父组件刷新并关闭
      await onSave?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal ${editing ? 'modal-wide bill-edit' : 'modal-detail'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bill-title"
        onClick={(event) => event.stopPropagation()}
      >
        {editing ? (
          <form className="bill-edit-form" onSubmit={save}>
            <h2 id="bill-title">编辑账单</h2>
            <div className="bill-edit-body">
            {books.books.find((book) => book.id === tx.bookId)?.kind !== 'personal' && tx.bookId ? (
              <SharedBillFields
                form={form}
                setForm={setForm}
                accounts={books.accounts}
                categories={books.categories}
                participants={bookPeopleNames(books.books.find((book) => book.id === tx.bookId))}
                requireMember={bookAaOn(books.books.find((book) => book.id === tx.bookId))}
              />
            ) : (
              <BookFields form={form} setForm={setForm} accounts={books.accounts} categories={books.categories} showImages />
            )}
            {error && <div className="error">{error}</div>}
            </div>
            <div className="modal-actions">
              <button className="secondary" type="button" onClick={() => setEditing(false)}>取消</button>
              <button className="primary" type="submit" disabled={saving}>{saving ? '保存中' : '保存'}</button>
            </div>
          </form>
        ) : (
          <>
            <h2 id="bill-title">{billTitle(tx)}{flag && <span className={`tx-flag ${flag.kind}`}>{flag.label}</span>}</h2>
            <div className={`modal-amount ${tx.type}`}>{signedMoney(tx)}</div>
            <dl className="detail-grid">
              {rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {tx.images?.length > 0 && (
              <div className="image-grid">
                {tx.images.map((url) => <BillImage key={url} url={url} />)}
              </div>
            )}
            <div className="modal-actions">
              <button className="secondary" type="button" onClick={onClose}>关闭</button>
              <button
                className="danger"
                type="button"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await onDelete(tx.id);
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? '删除中…' : '删除'}
              </button>
              <button className="primary" type="button" onClick={startEdit}>编辑</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

const TREND_RANGES = [
  ['month', '当月'],
  ['3m', '近三个月'],
  ['year', '近一年'],
  ['all', '全部'],
  ['custom', '自定义'],
];

// 每个月数含当月：当月 1 个、近三个月 3 个、近一年 12 个
const RANGE_MONTHS = { month: 1, '3m': 3, year: 12 };

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 总览页所有数据共用一个时间区间：以光标所在月为末尾，往前推相应月数。
// 「全部」不按月取整，直接用第一笔到最后一笔的日期，否则会一直显示到本月底
function rangeWindow(cursor, range, firstDate, lastDate, custom) {
  if (range === 'custom' && custom?.from && custom?.to) {
    return { from: custom.from, to: custom.to, label: `${custom.from} ~ ${custom.to}` };
  }
  if (range === 'all') {
    const from = firstDate || localDate(new Date(cursor.year, cursor.month - 1, 1));
    const to = lastDate || localDate(new Date(cursor.year, cursor.month, 0));
    return { from, to: to < from ? from : to, label: `${from} ~ ${to}` };
  }
  const to = localDate(new Date(cursor.year, cursor.month, 0));
  const from = localDate(new Date(cursor.year, cursor.month - (RANGE_MONTHS[range] || 1), 1));
  return { from, to, label: range === 'month' ? `${cursor.year} 年 ${cursor.month} 月` : `${from} ~ ${to}` };
}

function axisMoney(value) {
  const n = Number(value) || 0;
  if (n >= 10000) {
    const wan = n / 10000;
    return `${wan >= 10 ? Math.round(wan) : wan.toFixed(1)}万`;
  }
  if (n >= 100) return String(Math.round(n));
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function TrendChart({ points, unit }) {
  const [hover, setHover] = useState(null);
  if (!points.length) return <p className="muted">这段时间还没有收支。</p>;
  const width = 640;
  const height = 220;
  const pad = { l: 48, r: 8, t: 12, b: 28 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...points.flatMap((point) => [Number(point.expense), Number(point.income)]));
  const yOf = (value) => pad.t + innerH - (Number(value) / max) * innerH;
  const xOf = (index) => pad.l + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const line = (key) => points.map((point, index) => `${index ? 'L' : 'M'}${xOf(index).toFixed(1)},${yOf(point[key]).toFixed(1)}`).join(' ');
  const ticks = unit === 'month'
    ? points.map((_, index) => index).filter((index) => points.length <= 12 || index % Math.ceil(points.length / 8) === 0 || index === points.length - 1)
    : points.map((point, index) => ({ index, day: Number(point.label) })).filter(({ index, day }) => day === 1 || day % 5 === 0 || index === points.length - 1).map(({ index }) => index);
  const yTicks = [max, max / 2, 0];
  const active = hover == null ? null : points[hover];

  function move(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let best = Infinity;
    points.forEach((_, index) => {
      const distance = Math.abs(xOf(index) - x);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    setHover(nearest);
  }

  return (
    <div className="trend-wrap">
      <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="收支折线" onPointerMove={move} onPointerLeave={() => setHover(null)}>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={yOf(tick)} y2={yOf(tick)} className="trend-grid" />
            <text x={pad.l - 8} y={yOf(tick) + 4} className="trend-label" textAnchor="end">{axisMoney(tick)}</text>
          </g>
        ))}
        <path d={line('expense')} className="trend-line expense" />
        <path d={line('income')} className="trend-line income" />
        {ticks.map((index) => (
          <text key={points[index].key} x={xOf(index)} y={height - 8} className="trend-label" textAnchor="middle">{points[index].label}</text>
        ))}
        {active && (
          <g>
            <line x1={xOf(hover)} x2={xOf(hover)} y1={pad.t} y2={pad.t + innerH} className="trend-guide" />
            <circle cx={xOf(hover)} cy={yOf(active.expense)} r="3.5" className="trend-dot expense" />
            <circle cx={xOf(hover)} cy={yOf(active.income)} r="3.5" className="trend-dot income" />
          </g>
        )}
      </svg>
      {active && (
        <div className="trend-tip" style={{ left: `${Math.min(86, Math.max(14, (xOf(hover) / width) * 100))}%` }}>
          <div>{active.key}</div>
          <div className="expense">支出 {money(active.expense)}</div>
          <div className="income">收入 {money(active.income)}</div>
        </div>
      )}
    </div>
  );
}

// 饼图分类不再只取前 8 个，色板要够用，否则相邻扇区会撞色
const PIE_COLORS = [
  '#ff4d6a', '#7c5cff', '#2ec4b6', '#ffb703', '#4ea8de', '#f072b6', '#00b894', '#ff8c42',
  '#5b8def', '#e5679b', '#3ddc97', '#f6c445', '#8f7bff', '#ff7a5c', '#26c6da', '#a3d139',
  '#d7609a', '#6f8cff', '#ffa62b', '#4bc0a8', '#c86bfa', '#f2545b', '#59b4f5', '#b0c53d',
];

function CategoryPie({ items, activeName, onPick, kind = 'expense' }) {
  const total = items.reduce((sum, item) => sum + Number(item.amount), 0);
  if (!items.length || total <= 0) return <p className="muted">这段时间还没有{kind === 'income' ? '收入' : '支出'}。</p>;
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const outer = 92;
  const inner = 54;
  let angle = -Math.PI / 2;
  const slices = items.map((item, index) => {
    const share = Number(item.amount) / total;
    // 留出极小的缝隙，避免单个分类占满时首尾角度重合画不出来
    const sweep = Math.min(Math.PI * 2 - 0.0001, share * Math.PI * 2);
    const start = angle;
    const end = angle + sweep;
    angle = end;
    return { item, start, end, share, color: PIE_COLORS[index % PIE_COLORS.length] };
  });
  const point = (arc, radius) => `${(cx + radius * Math.cos(arc)).toFixed(2)},${(cy + radius * Math.sin(arc)).toFixed(2)}`;
  function arcPath(slice) {
    const large = slice.end - slice.start > Math.PI ? 1 : 0;
    return [
      `M${point(slice.start, outer)}`,
      `A${outer},${outer} 0 ${large} 1 ${point(slice.end, outer)}`,
      `L${point(slice.end, inner)}`,
      `A${inner},${inner} 0 ${large} 0 ${point(slice.start, inner)}`,
      'Z',
    ].join(' ');
  }
  return (
    <div className="pie-wrap">
      <svg className="pie-chart" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="支出分类占比">
        {slices.map((slice) => (
          <path
            key={slice.item.name}
            d={arcPath(slice)}
            fill={slice.color}
            className={`pie-slice${activeName === slice.item.name ? ' active' : ''}`}
            onClick={() => onPick(slice.item)}
          >
            <title>{slice.item.name} {money(slice.item.amount)}</title>
          </path>
        ))}
        <text x={cx} y={cy - 2} className="pie-total" textAnchor="middle">{money(total)}</text>
        <text x={cx} y={cy + 18} className="pie-label" textAnchor="middle">{kind === 'income' ? '收入合计' : '支出合计'}</text>
      </svg>
      <ul className="pie-legend">
        {slices.map((slice) => (
          <li key={slice.item.name}>
            <button type="button" className={activeName === slice.item.name ? 'active' : ''} onClick={() => onPick(slice.item)}>
              <i style={{ background: slice.color }} />
              <span>{slice.item.name}</span>
              <b>¥{money(slice.item.amount)}</b>
              <em>{Math.round(slice.share * 100)}%</em>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// 点饼图扇区后展开的账单明细，分类饼图和人员饼图共用
function PieBillList({ bills, emptyText, onOpen }) {
  return (
    <div className="ledger">
      {bills.map((tx) => {
        const flag = billFlag(tx);
        return (
          <button className="tx-row" type="button" key={tx.id} onClick={() => onOpen(tx)}>
            <span className={`tx-mark ${tx.type}`}>{typeLabel(tx.type).slice(0, 1)}</span>
            <span className="tx-main">
              <span className="tx-title">{billTitle(tx)}</span>
              <span className="tiny muted">{[formatWhen(tx.occurredAt), tx.memberName, tx.categoryName, accountLine(tx)].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="tx-side">
              {flag && <span className={`tx-flag ${flag.kind}`}>{flag.label}</span>}
              <span className={`tx-amount ${tx.type}`}>{signedMoney(tx)}</span>
            </span>
          </button>
        );
      })}
      {bills.length === 0 && <p className="muted">{emptyText}</p>}
    </div>
  );
}

function Overview() {
  const { saved, bump } = useRefresh();
  const books = useBooks();
  const { bookQuery } = books;
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [summary, setSummary] = useState(null);
  const [recent, setRecent] = useState([]);
  const [range, setRange] = useState('month');
  const [trend, setTrend] = useState(null);
  // 汇总默认先看饼图，折线留着但不再是默认
  const [trendMode, setTrendMode] = useState('pie');
  const [piePick, setPiePick] = useState(null);
  const [pieBills, setPieBills] = useState([]);
  // 饼图分支出、收入两套，各自列出所有分类
  const [pieKind, setPieKind] = useState('expense');
  const [pieOpen, setPieOpen] = useState(null);
  // 人员汇总饼图：出游/家庭账本里按付款人统计，同样分支出、收入两套
  const [memberKind, setMemberKind] = useState('expense');
  const [memberPick, setMemberPick] = useState(null);
  const [memberBills, setMemberBills] = useState([]);
  const [memberOpen, setMemberOpen] = useState(null);
  const [openTx, setOpenTx] = useState(null);
  const monthStart = useMemo(() => localDate(new Date(now.getFullYear(), now.getMonth(), 1)), []);
  const monthEnd = useMemo(() => localDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)), []);
  const [custom, setCustom] = useState({ from: monthStart, to: monthEnd });
  const win = useMemo(
    () => rangeWindow(cursor, range, summary?.firstDate, summary?.lastDate, custom),
    [cursor, range, summary?.firstDate, summary?.lastDate, custom],
  );
  useEffect(() => {
    api(`/api/summary?from=${win.from}&to=${win.to}&${bookQuery}`).then(setSummary);
    api(`/api/transactions?from=${win.from}&to=${win.to}&${bookQuery}`).then((data) => setRecent(data.transactions.slice(0, 8)));
  }, [win.from, win.to, saved, bookQuery]);
  useEffect(() => {
    api(`/api/trend?from=${win.from}&to=${win.to}&${bookQuery}`).then(setTrend).catch(() => setTrend(null));
  }, [win.from, win.to, saved, bookQuery]);
  // 共享/出游账本默认看「全部」（旅行就那几天，按月切很容易是空白），个人账本还是看当月
  useEffect(() => {
    const kind = books.currentBook?.kind;
    setRange(kind && kind !== 'personal' ? 'all' : 'month');
  }, [books.currentBook?.id]);
  function shift(delta) {
    const d = new Date(cursor.year, cursor.month - 1 + delta, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 });
    setPiePick(null);
    setMemberPick(null);
  }
  const bookSuffix = bookQuery ? `&${bookQuery}` : '';
  // ids 为空表示「未分类」，后端用 none 匹配没有分类的账单
  const pieItems = pieKind === 'income' ? (summary?.incomeCategories || []) : (summary?.categories || []);
  // 有 category_id 就按 id 筛；手填分类只有文本（ids 为空），改用分类名筛
  const pieQuery = (item) => {
    const ids = item?.ids || [];
    let filter = 'categoryIds=none';
    if (ids.length) filter = `categoryIds=${ids.join(',')}`;
    else if (item?.name && item.name !== '未分类') filter = `categoryLabel=${encodeURIComponent(item.name)}`;
    return `/api/transactions?from=${win.from}&to=${win.to}&type=${pieKind}&${filter}${bookSuffix}`;
  };
  // 人员汇总：只要有带名字的 member_name 就显示，不再限制账本类型
  const allRealMembers = [
    ...(summary?.members || []),
    ...(summary?.incomeMembers || []),
  ].filter((item) => item.name !== '未填');
  const hasRealMembers = allRealMembers.length > 0;
  const memberItems = (memberKind === 'income' ? (summary?.incomeMembers || []) : (summary?.members || [])).filter((item) => item.name !== '未填');
  const memberQuery = (name) => `/api/transactions?from=${win.from}&to=${win.to}&type=${memberKind}&memberName=${encodeURIComponent(name)}${bookSuffix}`;
  // AA 平摊：两个人以上才谈得上平摊；开了 AA 的账本自己则总是显示，方便看完再补付款人
  const isAaBook = bookAaOn(books.currentBook);
  const aa = summary?.aa && (summary.aa.memberCount >= 2 || isAaBook) ? summary.aa : null;
  function switchMemberKind(value) {
    setMemberKind(value);
    setMemberPick(null);
  }
  function pickMember(item) {
    if (memberPick?.name === item.name) {
      setMemberPick(null);
      return;
    }
    setMemberPick(item);
    api(memberQuery(item.name)).then((data) => setMemberBills(data.transactions));
  }
  async function removeMemberBill(id) {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    setMemberOpen(null);
    const data = await api(memberQuery(memberPick.name));
    setMemberBills(data.transactions);
    bump();
  }
  function switchPieKind(value) {
    setPieKind(value);
    setPiePick(null);
  }
  function pickCategory(item) {
    if (piePick?.name === item.name) {
      setPiePick(null);
      return;
    }
    setPiePick(item);
    api(pieQuery(item)).then((data) => setPieBills(data.transactions));
  }
  async function removePieBill(id) {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    setPieOpen(null);
    const data = await api(pieQuery(piePick));
    setPieBills(data.transactions);
    bump();
  }
  // 时间范围或账本变了就收起明细，避免列表停留在旧区间
  useEffect(() => {
    setPiePick(null);
    setMemberPick(null);
  }, [win.from, win.to, bookQuery]);
  // 账单有增删改时（saved 变化），展开中的饼图明细跟着刷新
  useEffect(() => {
    if (!piePick && !memberPick) return;
    if (piePick) api(pieQuery(piePick)).then((data) => setPieBills(data.transactions)).catch(() => {});
    if (memberPick) api(memberQuery(memberPick.name)).then((data) => setMemberBills(data.transactions)).catch(() => {});
  }, [saved]);
  const max = Math.max(...(pieItems.map((c) => Number(c.amount)) || [1]), 1);
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
          <h1>{win.label}</h1>
        </div>
        <div className="row ov-tools">
          <div className="segment" role="tablist">
            {TREND_RANGES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={range === value ? 'active' : ''}
                onClick={() => { setRange(value); setPiePick(null); setMemberPick(null); }}
              >
                {label}
              </button>
            ))}
          </div>
          {range === 'custom' && (
            <>
              <label className="row">从<input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
              <label className="row">到<input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
            </>
          )}
          {range !== 'all' && range !== 'custom' && (
            <div className="row month-nav">
              <button className="secondary" type="button" onClick={() => shift(-1)}>{range === 'month' ? '上个月' : '前一月'}</button>
              <button className="secondary" type="button" onClick={() => shift(1)}>{range === 'month' ? '下个月' : '后一月'}</button>
            </div>
          )}
        </div>
      </div>
      <section className="hero">
        <div className="hero-main">
          <span className="hero-label">结余</span>
          <span className="hero-value">{summary ? money(summary.net, true) : '—'}</span>
          <span className="tiny muted">{win.from} 至 {win.to}</span>
        </div>
        <div className="hero-split">
          <div className="hero-cell">
            <span>支出</span>
            <b className="expense">{summary ? money(summary.expense) : '—'}</b>
          </div>
          <div className="hero-cell">
            <span>收入</span>
            <b className="income">{summary ? money(summary.income) : '—'}</b>
          </div>
        </div>
      </section>
      {aa && (
        <section className="card trend-card">
          <div className="card-head">
            <h2>AA 平摊</h2>
            <span className="tiny muted">总花费 {money(aa.total)} · {aa.memberCount} 人分摊</span>
          </div>
          <div className="table-scroll">
            <table className="aa-table">
              <thead>
                <tr><th>成员</th><th>已付</th><th>应摊</th><th>差额</th></tr>
              </thead>
              <tbody>
                {aa.members.map((item) => {
                  const diff = Number(item.diff);
                  return (
                    <tr key={item.name}>
                      <td>{item.name}</td>
                      <td>{money(item.paid)}</td>
                      <td>{money(item.share)}</td>
                      <td className={diff > 0 ? 'income' : diff < 0 ? 'expense' : 'muted'}>
                        {diff > 0 ? `应收 ${money(item.diff)}` : diff < 0 ? `应付 ${money(-diff)}` : '已平'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {aa.transfers.length > 0 && (
            <div className="aa-transfers">
              <h3>结算建议</h3>
              <ul>
                {aa.transfers.map((item) => (
                  <li key={`${item.from}-${item.to}-${item.amount}`}>
                    <b>{item.from}</b> 转给 <b>{item.to}</b> <span>{money(item.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Number(aa.unassigned) !== 0 && (
            <p className="tiny muted">还有 {money(aa.unassigned)} 没填付款人，也一起算进平摊了。</p>
          )}
          {aaSelfNote(aa) && <p className="tiny muted">{aaSelfNote(aa)}</p>}
        </section>
      )}
      <section className="card trend-card">
        <div className="card-head">
          <h2>{trendMode === 'line' ? '收支走势' : `${pieKind === 'income' ? '收入' : '支出'}分类占比`}</h2>
          <div className="row">
            <div className="segment" role="tablist">
              {[['line', '折线'], ['pie', '饼图']].map(([value, label]) => (
                <button key={value} type="button" className={trendMode === value ? 'active' : ''} onClick={() => setTrendMode(value)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        {trendMode === 'line' ? (
          <>
            <div className="legend">
              <span className="expense">支出</span>
              <span className="income">收入</span>
            </div>
            {trend ? <TrendChart points={trend.points} unit={trend.unit} /> : <p className="muted">加载中…</p>}
          </>
        ) : (
          <>
            <div className="segment kind-switch" role="tablist" aria-label="饼图收支">
              {[['expense', '支出'], ['income', '收入']].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-kind={value}
                  className={pieKind === value ? 'active' : ''}
                  onClick={() => switchPieKind(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <CategoryPie items={pieItems} activeName={piePick?.name} onPick={pickCategory} kind={pieKind} />
            {piePick && (
              <div className="pie-bills">
                <div className="tree-head">
                  <h2>{piePick.name} · {pieBills.length} 笔</h2>
                  <button className="secondary small" type="button" onClick={() => setPiePick(null)}>收起</button>
                </div>
                <PieBillList bills={pieBills} emptyText="这个分类下没有账单。" onOpen={setPieOpen} />
              </div>
            )}
          </>
        )}
      </section>
      {hasRealMembers && (
        <section className="card trend-card">
          <div className="card-head">
            <h2>{`${memberKind === 'income' ? '收入' : '支出'}人员占比`}</h2>
          </div>
          <div className="segment kind-switch" role="tablist" aria-label="人员饼图收支">
            {[['expense', '支出'], ['income', '收入']].map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-kind={value}
                className={memberKind === value ? 'active' : ''}
                onClick={() => switchMemberKind(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <CategoryPie items={memberItems} activeName={memberPick?.name} onPick={pickMember} kind={memberKind} />
          {memberPick && (
            <div className="pie-bills">
              <div className="tree-head">
                <h2>{memberPick.name} · {memberBills.length} 笔</h2>
                <button className="secondary small" type="button" onClick={() => setMemberPick(null)}>收起</button>
              </div>
              <PieBillList bills={memberBills} emptyText="这个成员下没有账单。" onOpen={setMemberOpen} />
            </div>
          )}
        </section>
      )}
      {pieOpen && (
        <BillDetail
          tx={pieOpen}
          onClose={() => setPieOpen(null)}
          onDelete={removePieBill}
          onSave={async () => {
            setPieOpen(null);
            const data = await api(pieQuery(piePick));
            setPieBills(data.transactions);
            bump();
          }}
        />
      )}
      {memberOpen && (
        <BillDetail
          tx={memberOpen}
          onClose={() => setMemberOpen(null)}
          onDelete={removeMemberBill}
          onSave={async () => {
            setMemberOpen(null);
            const data = await api(memberQuery(memberPick?.name));
            setMemberBills(data.transactions);
            bump();
          }}
        />
      )}
      <div className="grid cards" style={{ marginTop: 12 }}>
        <section className="card">
          <h2>{pieKind === 'income' ? '收入分类' : '支出分类'}</h2>
          <div className="list">
            {pieItems.map((item) => (
              <div key={item.name}>
                <div className="item"><span>{item.name}</span><b>¥{money(item.amount)}</b></div>
                <div className="bar"><span className={pieKind} style={{ width: `${(Number(item.amount) / max) * 100}%` }} /></div>
              </div>
            ))}
            {summary && pieItems.length === 0 && <p className="muted">这段时间还没有{pieKind === 'income' ? '收入' : '支出'}。</p>}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>最近账单</h2></div>
          <div className="ledger">
            {recent.map((tx) => (
              <button className="tx-row" type="button" key={tx.id} onClick={() => setOpenTx(tx)}>
                <span className={`tx-mark ${tx.type}`}>{typeLabel(tx.type).slice(0, 1)}</span>
                <span className="tx-main">
                  <span className="tx-title">{billTitle(tx)}</span>
                  <span className="tiny muted">{[formatWhen(tx.occurredAt), tx.memberName, accountLine(tx)].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="tx-side">
                  <span className={`tx-amount ${tx.type}`}>{signedMoney(tx)}</span>
                </span>
              </button>
            ))}
            {recent.length === 0 && <p className="muted">还没有账单。</p>}
          </div>
        </section>
      </div>
      {openTx && (
        <BillDetail
          tx={openTx}
          onClose={() => setOpenTx(null)}
          onDelete={async (id) => {
            await api(`/api/transactions/${id}`, { method: 'DELETE' });
            setOpenTx(null);
            bump();
          }}
          onSave={() => { setOpenTx(null); bump(); }}
        />
      )}
    </>
  );
}

function CalendarPage() {
  const books = useBooks();
  const { saved } = useRefresh();
  const { bookQuery } = books;
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [days, setDays] = useState([]);
  const [picked, setPicked] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(null);
  const calRef = useRef(null);
  useEffect(() => {
    api(`/api/calendar?year=${cursor.year}&month=${cursor.month}&${bookQuery}`).then((data) => setDays(data.days));
  }, [cursor, bookQuery, saved]);
  useEffect(() => {
    if (!picked) return;
    api(`/api/transactions?from=${picked}&to=${picked}&${bookQuery}`).then((data) => setItems(data.transactions));
  }, [picked, bookQuery, saved]);
  const map = useMemo(() => Object.fromEntries(days.map((d) => [d.day, d])), [days]);
  const first = new Date(cursor.year, cursor.month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const count = new Date(cursor.year, cursor.month, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const weekCount = Math.ceil(cells.length / 7);
  const pickedWeek = picked ? Math.floor((lead + Number(picked.slice(-2)) - 1) / 7) : 0;
  useLayoutEffect(() => {
    const main = document.querySelector('.main');
    const root = calRef.current;
    if (!main || !root) return undefined;
    const body = root.querySelector('.cal-body');
    const weeks = root.querySelector('.cal-weeks');
    const narrow = window.matchMedia('(max-width: 900px)');
    let rowH = 0;
    let full = 0;
    let collapsed = false;
    let lockUntil = 0;
    let ignoreUntil = 0;
    let baseTop = 0;

    function clearFold() {
      collapsed = false;
      lockUntil = 0;
      ignoreUntil = 0;
      root.classList.remove('cal-fold');
      root.style.removeProperty('--cal-row');
      if (!body || !weeks) return;
      body.style.transition = '';
      body.style.overflow = '';
      body.style.height = '';
      weeks.style.transition = '';
      weeks.style.transform = '';
    }
    // 选中当天只锁定行高，不播高度动画。列表一出现就会带动滚动，若马上跟着收起，日历就会上下抖。
    function measure() {
      clearFold();
      if (!body || !weeks || !narrow.matches || !picked) return;
      body.style.height = 'auto';
      weeks.style.transform = 'none';
      const slots = [...weeks.querySelectorAll(':scope > .day')];
      const stride = slots.length > 7 ? slots[7].offsetTop - slots[0].offsetTop : 0;
      rowH = stride > 1 ? stride : (slots[0] ? slots[0].offsetHeight : 48);
      if (rowH < 1) rowH = 48;
      full = body.offsetHeight;
      root.style.setProperty('--cal-row', `${rowH}px`);
      root.classList.add('cal-fold');
      body.style.overflow = 'hidden';
      body.style.height = `${full}px`;
      weeks.style.transform = 'translateY(0px)';
      baseTop = main.scrollTop;
      ignoreUntil = performance.now() + 450;
    }
    function armMotion() {
      if (body.style.transition) return;
      body.style.transition = 'height .28s ease';
      weeks.style.transition = 'transform .28s ease';
    }
    function setCollapsed(next) {
      if (next === collapsed || rowH < 1) return;
      collapsed = next;
      lockUntil = performance.now() + 340;
      armMotion();
      body.style.height = `${next ? rowH : full}px`;
      weeks.style.transform = next ? `translateY(${-pickedWeek * rowH}px)` : 'translateY(0px)';
    }
    function onScroll() {
      if (!narrow.matches || !picked || rowH < 1) return;
      const now = performance.now();
      if (now < ignoreUntil) {
        baseTop = main.scrollTop;
        return;
      }
      if (now < lockUntil) return;
      const top = main.scrollTop;
      if (!collapsed && top > baseTop + 24) setCollapsed(true);
      else if (collapsed && top < 1) setCollapsed(false);
    }
    measure();
    main.addEventListener('scroll', onScroll, { passive: true });
    narrow.addEventListener('change', measure);
    return () => {
      main.removeEventListener('scroll', onScroll);
      narrow.removeEventListener('change', measure);
      clearFold();
    };
  }, [picked, pickedWeek, weekCount]);
  function shift(delta) {
    const d = new Date(cursor.year, cursor.month - 1 + delta, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 });
    setPicked('');
  }
  const sumOf = (type) => items
    .filter((t) => t.type === type)
    .reduce((s, t) => s + Number(t.amount || 0), 0);
  async function reloadDay() {
    const data = await api(`/api/transactions?from=${picked}&to=${picked}&${bookQuery}`);
    setItems(data.transactions);
    const cal = await api(`/api/calendar?year=${cursor.year}&month=${cursor.month}&${bookQuery}`);
    setDays(cal.days);
  }
  async function remove(id) {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    setOpen(null);
    await reloadDay();
  }
  return (
    <>
      <div className={`cal-pin${picked ? ' has-day' : ''}`}>
        <div className="page-head cal-head">
          <div>
            <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
            <h1>日历</h1>
          </div>
          <div className="row cal-nav">
            <button className="secondary" type="button" onClick={() => shift(-1)}>上个月</button>
            <strong>{cursor.year} 年 {cursor.month} 月</strong>
            <button className="secondary" type="button" onClick={() => shift(1)}>下个月</button>
          </div>
        </div>
        <div className="calendar" ref={calRef}>
          <div className="cal-dows">
            {WEEKDAYS.map((name) => <div className="dow" key={name}>{name}</div>)}
          </div>
          <div className="cal-body">
            <div className="cal-weeks">
            {cells.map((day, index) => {
              if (!day) return <div className="day empty" key={`e${index}`} />;
              const key = `${cursor.year}-${String(cursor.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const info = map[key];
              const cls = ['day'];
              if (key === todayKey) cls.push('today');
              if (key === picked) cls.push('picked');
              return (
                <div className={cls.join(' ')} key={key} role="button" tabIndex={0} onClick={() => setPicked(key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPicked(key); }}>
                  <button className="pick" type="button" tabIndex={-1}>{day}</button>
                  {(info && (Number(info.expense) > 0 || Number(info.income) > 0 || info.planned?.length > 0)) && (
                    <div className="day-marks">
                      {Number(info.expense) > 0 && <div className="tiny expense">-{money(info.expense)}</div>}
                      {Number(info.income) > 0 && <div className="tiny income">+{money(info.income)}</div>}
                      {info.planned?.length > 0 && <div className="tiny muted">待入账 {info.planned.length}</div>}
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </div>
        </div>
        {picked && (
          <div className="cal-day-bar">
            <h2>{picked}</h2>
            <div className="row">
              {sumOf('expense') > 0 && <span className="tiny expense">支出 {money(sumOf('expense'))}</span>}
              {sumOf('income') > 0 && <span className="tiny income">收入 {money(sumOf('income'))}</span>}
              <button className="secondary small" type="button" onClick={() => { setPicked(''); const main = document.querySelector('.main'); if (main) main.scrollTop = 0; }}>收起</button>
            </div>
          </div>
        )}
      </div>
      {picked && (
        <section className="card cal-day" style={{ marginTop: 16 }}>
          <div className="tree-head">
            <h2>{picked}</h2>
            <div className="row">
              {sumOf('expense') > 0 && <span className="tiny expense">支出 {money(sumOf('expense'))}</span>}
              {sumOf('income') > 0 && <span className="tiny income">收入 {money(sumOf('income'))}</span>}
              <button className="secondary small" type="button" onClick={() => { setPicked(''); const main = document.querySelector('.main'); if (main) main.scrollTop = 0; }}>收起</button>
            </div>
          </div>
          <div className="ledger">
            {items.map((tx) => {
              const flag = billFlag(tx);
              return (
                <button className="tx-row" type="button" key={tx.id} onClick={() => setOpen(tx)}>
                  <span className={`tx-mark ${tx.type}`}>{typeLabel(tx.type).slice(0, 1)}</span>
                  <span className="tx-main">
                    <span className="tx-title">{billTitle(tx)}</span>
                    <span className="tiny muted">{[formatWhen(tx.occurredAt), tx.categoryName, accountLine(tx)].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="tx-side">
                    {flag && <span className={`tx-flag ${flag.kind}`}>{flag.label}</span>}
                    <span className={`tx-amount ${tx.type}`}>{signedMoney(tx)}</span>
                  </span>
                </button>
              );
            })}
            {items.length === 0 && <p className="muted">这一天还没有账单。</p>}
            {(map[picked]?.planned || []).map((plan) => (
              <div className="item" key={`p${plan.id}${plan.amount}`}>
                <span className="muted">待入账 · {plan.payee || plan.note || '定期账单'}</span>
                <b className="muted">{money(plan.amount)}</b>
              </div>
            ))}
          </div>
        </section>
      )}
      {open && (
        <BillDetail
          tx={open}
          onClose={() => setOpen(null)}
          onDelete={(id) => remove(id)}
          onSave={async () => { setOpen(null); await reloadDay(); }}
        />
      )}
    </>
  );
}

function Bills() {
  const books = useBooks();
  // 记一笔/改一笔之后 saved 会变，列表要跟着重新拉，不然新账看不到
  const { saved } = useRefresh();
  const { categories } = books;
  const activeBookId = books.currentBookId;
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [source, setSource] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [sort, setSort] = useState('');
  const [accountId, setAccountId] = useState('');
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [exporting, setExporting] = useState('');
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState('');
  // 批量改分类：勾选账单后统一设置，picked 是 id → true
  const [picked, setPicked] = useState({});
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkCatQuery, setBulkCatQuery] = useState('');
  const [bulkCatOpen, setBulkCatOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  // 当前筛选条件下的金额合计（后端按全部匹配项统计，不只是已加载的）
  const [summary, setSummary] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  useScrollLock(filterOpen);
  const bookId = activeBookId || '';
  function queryString(overrides = {}) {
    const pick = (key, current) => (Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : current);
    const params = new URLSearchParams();
    const sortValue = pick('sort', sort);
    const offsetValue = pick('offset', offset);
    const typeValue = pick('type', type);
    const sourceValue = pick('source', source);
    const accountValue = pick('accountId', accountId);
    const categoryValue = pick('categoryId', categoryId);
    const fromValue = pick('from', from);
    const toValue = pick('to', to);
    const minValue = pick('minAmount', minAmount);
    const maxValue = pick('maxAmount', maxAmount);
    const qValue = pick('q', q);
    if (sortValue) params.set('sort', sortValue);
    if (accountValue) params.set('accountIds', accountValue);
    if (offsetValue) params.set('offset', offsetValue);
    params.set('limit', String(BILL_PAGE_SIZE));
    if (String(qValue || '').trim()) params.set('q', String(qValue).trim());
    if (fromValue) params.set('from', fromValue);
    if (toValue) params.set('to', toValue);
    if (typeValue) params.set('type', typeValue);
    if (sourceValue) params.set('source', sourceValue);
    if (categoryValue) params.set('categoryIds', categoryValue);
    if (minValue !== '') params.set('minAmount', minValue);
    if (maxValue !== '') params.set('maxAmount', maxValue);
    if (bookId) params.set('bookId', bookId);
    const text = params.toString();
    return text ? `?${text}` : '';
  }
  // 分类下拉跟着账单类型走：选了支出就只列支出分类
  const cats = categories.filter((c) => !c.archived && (!type || c.kind === type));
  const catParents = cats.filter((c) => !c.parentId);
  const catChildrenOf = (id) => cats.filter((c) => c.parentId === id);
  async function load(overrides, append = false) {
    // 换筛选条件时从头开始；「加载更多」才追加
    const next = append ? { ...overrides } : { offset: 0, ...overrides };
    if (!append) setOffset(0);
    setNotice('');
    const data = await api(`/api/transactions${queryString(next)}`);
    setRows((prev) => (append ? [...prev, ...data.transactions] : data.transactions));
    setTotal(data.total ?? data.transactions.length);
    setSummary(data.summary || null);
    if (!append) setPicked({});
  }

  const pickedIds = Object.keys(picked).filter((id) => picked[id]).map(Number);
  const shownIds = rows.map((row) => row.id).filter((id) => picked[id]);
  function togglePick(id) {
    setPicked((prev) => ({ ...prev, [id]: !prev[id] }));
  }
  // 批量改分类的候选：分类多了靠搜，父分类名也算关键字（搜「餐饮」能出「餐饮 / 午饭」）
  const bulkCatOptions = [
    { id: '__none__', name: '清除分类', parentName: '', kind: '' },
    ...categories.filter((c) => !c.archived).map((c) => {
      const parent = c.parentId ? categories.find((p) => p.id === c.parentId) : null;
      return { id: String(c.id), name: c.name, parentName: parent ? parent.name : '', kind: c.kind };
    }),
  ];
  const bulkKeyword = bulkCatQuery.trim().toLowerCase();
  const bulkMatches = bulkKeyword
    ? bulkCatOptions.filter((c) => `${c.parentName}${c.name}`.toLowerCase().includes(bulkKeyword))
    : bulkCatOptions;
  // 点了候选就锁住；只输关键字没点，回车/点应用就取第一个匹配
  const bulkTarget = bulkCategory || (bulkKeyword ? bulkMatches[0]?.id || '' : '');
  function pickBulkCategory(option) {
    setBulkCategory(option.id);
    setBulkCatQuery(option.parentName ? `${option.parentName} / ${option.name}` : option.name);
    setBulkCatOpen(false);
  }
  // 批量改分类：空分类表示清成未分类
  async function applyBulkCategory(nextCategoryId) {
    const ids = pickedIds;
    if (!ids.length) return;
    setBulkBusy(true);
    setError('');
    try {
      const result = await api('/api/transactions/category', {
        method: 'PATCH',
        body: { ids, categoryId: nextCategoryId ? Number(nextCategoryId) : null },
      });
      setPicked({});
      setBulkCategory('');
      setBulkCatQuery('');
      await load();
      setNotice(`已改 ${result.updated} 笔的分类`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkBusy(false);
    }
  }
  async function loadMore() {
    const next = rows.length;
    setOffset(next);
    setLoadingMore(true);
    setError('');
    try {
      await load({ offset: next }, true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  }
  async function download(format) {
    setExporting(format);
    setError('');
    try {
      const file = await fetchExport(format, queryString());
      saveFile(file.blob, file.filename);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting('');
    }
  }
  useEffect(() => { load().catch((err) => setError(err.message)); }, [bookId, saved]);
  async function remove(id) {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    setSelected(null);
    await load();
  }
  async function confirmRemove() {
    const id = pendingDelete?.id;
    setPendingDelete(null);
    setError('');
    try {
      await remove(id);
    } catch (err) {
      setError(err.message);
    }
  }
  // 按金额排序时不再按天分组，平铺展示
  const groups = sort ? (rows.length ? [{ day: '', items: rows }] : []) : groupByDay(rows);
  const sortLabel = BILL_SORTS.find(([value]) => value === sort)?.[1] || '按金额排序';
  const filterCount = [type, source, accountId, categoryId, from, to, minAmount, maxAmount].filter(Boolean).length;
  function renderFilterFields() {
    return (
      <>
        <label>类型
          <AppSelect value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">全部</option>
            {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </AppSelect>
        </label>
        <label>来源
          <AppSelect value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(SOURCES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </AppSelect>
        </label>
        <label>账户
          <AppSelect value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">全部</option>
            {books.accounts.filter((a) => !a.archived && !a.mergedInto).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </AppSelect>
        </label>
        <label>分类
          <AppSelect value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">全部</option>
            <option value="none">未分类</option>
            {catParents.map((parent) => (
              <optgroup key={parent.id} label={parent.name}>
                <option value={parent.id}>{parent.name}（含子分类）</option>
                {catChildrenOf(parent.id).map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
              </optgroup>
            ))}
          </AppSelect>
        </label>
        <label>开始<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>结束<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>金额
          <span className="amount-range">
            <input type="number" step="0.01" placeholder="最小" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />
            <span className="muted">–</span>
            <input type="number" step="0.01" placeholder="最大" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />
          </span>
        </label>
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
          <h1>账单</h1>
        </div>
        <div className="row page-actions">
          <button className="secondary" type="button" disabled={!!exporting} onClick={() => download('csv')}>{exporting === 'csv' ? '导出中' : '导出 CSV'}</button>
          <button className="secondary" type="button" disabled={!!exporting} onClick={() => download('xlsx')}>{exporting === 'xlsx' ? '导出中' : '导出 Excel'}</button>
          <button className="danger" type="button" disabled={!!exporting} onClick={() => setClearing(true)}>清除账单</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="bill-pin">
      <form className="card row search-row" onSubmit={(e) => { e.preventDefault(); load().catch((err) => setError(err.message)); }}>
        <button
          className={`h5-only h5-filter-btn${filterCount ? ' has' : ''}`}
          type="button"
          onClick={() => setFilterOpen(true)}
        >
          筛选{filterCount ? ` · ${filterCount}` : ''}
        </button>
        <div className="bill-filter-inline">{renderFilterFields()}</div>
        <label className="grow">关键词
          <input placeholder="对方、备注、分类、账户、金额（空格分隔多个词）" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="primary" type="submit">查询</button>
        {(type || source || accountId || categoryId || from || to || minAmount !== '' || maxAmount !== '' || q.trim() || sort) && (
          <button
            className="ghost"
            type="button"
            onClick={() => {
              setType(''); setSource(''); setAccountId(''); setCategoryId(''); setFrom(''); setTo('');
              setMinAmount(''); setMaxAmount(''); setQ(''); setSort('');
              setFilterOpen(false);
              load({ type: '', source: '', accountId: '', categoryId: '', from: '', to: '', minAmount: '', maxAmount: '', q: '', sort: '' })
                .catch((err) => setError(err.message));
            }}
          >
            重置
          </button>
        )}
      </form>
      {filterOpen && createPortal(
        <div className="modal-backdrop" onClick={() => setFilterOpen(false)}>
          <div className="modal stack bill-filter-modal" role="dialog" aria-modal="true" aria-label="筛选" onClick={(event) => event.stopPropagation()}>
            <h2>筛选</h2>
            <div className="bill-filter-fields">{renderFilterFields()}</div>
            <div className="modal-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setType(''); setSource(''); setAccountId(''); setCategoryId(''); setFrom(''); setTo('');
                  setMinAmount(''); setMaxAmount('');
                  setFilterOpen(false);
                  load({ type: '', source: '', accountId: '', categoryId: '', from: '', to: '', minAmount: '', maxAmount: '' })
                    .catch((err) => setError(err.message));
                }}
              >
                重置
              </button>
              <button className="primary" type="button" onClick={() => { setFilterOpen(false); load().catch((err) => setError(err.message)); }}>查询</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      <div className="query-count muted">
        <div className="segment" role="tablist" aria-label="排序方式">
          {BILL_SORTS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={sort === value ? 'active' : ''}
              onClick={() => { setSort(value); load({ sort: value }).catch((err) => setError(err.message)); }}
            >
              {label}
            </button>
          ))}
        </div>
        <span>
          {total > rows.length
            ? `共 ${total} 笔，已显示 ${rows.length} 笔`
            : `共 ${total} 笔${rows.length ? '（全部）' : ''}`}
        </span>
        {summary && (
          <span className="bill-summary">
            支出 ¥{money(summary.expense)}
            <span className="muted">·</span>
            收入 ¥{money(summary.income)}
            <span className="muted">·</span>
            净额 <b className={`tx-amount ${Number(summary.net) < 0 ? 'expense' : 'income'}`}>¥{money(summary.net, true)}</b>
          </span>
        )}
        {notice && <span className="bill-summary">{notice}</span>}
      </div>
      </div>
      {shownIds.length > 0 && (
        <div className="card bill-bulk">
          <span>已选 <b>{shownIds.length}</b> 笔</span>
          <div className="member-picker bulk-cat-picker">
            <input
              value={bulkCatQuery}
              onChange={(e) => { setBulkCatQuery(e.target.value); setBulkCategory(''); setBulkCatOpen(true); }}
              onFocus={() => setBulkCatOpen(true)}
              onBlur={() => setBulkCatOpen(false)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                // 回车直接吃下第一个匹配项，省得再点一次下拉
                e.preventDefault();
                if (bulkMatches[0]) pickBulkCategory(bulkMatches[0]);
              }}
              placeholder="搜分类，比如 餐饮"
              autoComplete="off"
            />
            {bulkCatOpen && (
              <div className="member-suggest">
                {bulkMatches.length === 0 && <div className="member-suggest-empty tiny muted">没匹配到分类</div>}
                {bulkMatches.slice(0, 60).map((option) => (
                  <button
                    type="button"
                    className="member-suggest-item"
                    key={option.id}
                    // 按住鼠标不让输入框失焦，不然下拉先关掉，click 就收不到了
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickBulkCategory(option)}
                  >
                    <b>{option.parentName ? `${option.parentName} / ${option.name}` : option.name}</b>
                    <span className="tiny muted">
                      {option.kind === 'expense' ? '支出' : option.kind === 'income' ? '收入' : '不分类'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="primary small"
            type="button"
            disabled={bulkBusy || !bulkTarget}
            onClick={() => applyBulkCategory(bulkTarget === '__none__' ? '' : bulkTarget)}
          >
            {bulkBusy ? '处理中…' : '应用'}
          </button>
          <button className="ghost small" type="button" onClick={() => setPicked({})}>取消选择</button>
          <span className="spacer" />
          <button className="ghost small" type="button" onClick={() => setPicked(Object.fromEntries(rows.map((row) => [row.id, true])))}>
            全选已加载的 {rows.length} 笔
          </button>
        </div>
      )}
      <div className="card ledger">
        {groups.map((group) => (
          <section key={group.day}>
            <div className="tx-day">
              <span>{group.day ? formatDay(group.day) : sortLabel}</span>
              <span>{group.items.length} 笔</span>
            </div>
            {group.items.map((tx) => {
              const flag = billFlag(tx);
              return (
              <div className="tx-line" key={tx.id}>
                <label className="tx-pick" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={!!picked[tx.id]} onChange={() => togglePick(tx.id)} />
                </label>
                <button className="tx-row" type="button" onClick={() => setSelected(tx)}>
                  <span className={`tx-mark ${tx.type}`}>{typeLabel(tx.type).slice(0, 1)}</span>
                  <span className="tx-main">
                    <span className="tx-title">{billTitle(tx)}</span>
                    <span className="tiny muted">{[formatWhen(tx.occurredAt), tx.categoryName, accountLine(tx)].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="tx-side">
                    {flag && <span className={`tx-flag ${flag.kind}`}>{flag.label}</span>}
                    <span className={`tx-amount ${tx.type}`}>{signedMoney(tx)}</span>
                  </span>
                </button>
                <button className="tx-del" type="button" onClick={() => setPendingDelete(tx)}>删除</button>
              </div>
              );
            })}
          </section>
        ))}
        {rows.length === 0 && <p className="muted">没有账单。</p>}
        {rows.length > 0 && rows.length < total && (
          <div className="load-more">
            <button className="secondary" type="button" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? '加载中…' : `加载更多（还有 ${total - rows.length} 笔）`}
            </button>
          </div>
        )}
      </div>
      {selected && (
        <BillDetail
          tx={selected}
          onClose={() => setSelected(null)}
          onDelete={remove}
          onSave={async () => { setSelected(null); await load(); }}
        />
      )}
      {pendingDelete && (
        <ConfirmModal
          title="删除这笔账单？"
          body={`${formatWhen(pendingDelete.occurredAt)} · ${billTitle(pendingDelete)} · ${money(pendingDelete.amount)} 元。删除后无法恢复。`}
          confirmLabel="删除"
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmRemove}
        />
      )}
      {clearing && (
        <ClearBills
          onClose={() => setClearing(false)}
          currentBook={books.currentBook}
          bookId={activeBookId}
          bookQuery={books.bookQuery}
          onCleared={() => { setClearing(false); setSelected(null); load().catch((err) => setError(err.message)); }}
        />
      )}
    </>
  );
}

// 定期规则怎么重复，列表里要能一眼看出「每月 15 号」这种，而不是只知道「每月」
function ruleSchedule(rule) {
  if (rule.frequency === 'monthly') return `每月 ${rule.monthDay || '?'} 号`;
  if (rule.frequency === 'weekly') {
    const days = (rule.weekdays || []).map((d) => `周${WEEKDAYS[d - 1] || ''}`).join('、');
    return `每周${days || '—'}`;
  }
  if (rule.frequency === 'interval') return `每 ${rule.intervalDays || 1} 天`;
  if (rule.frequency === 'daily') return '每天';
  if (rule.frequency === 'yearly') return `每年 ${rule.yearMonth || '?'} 月 ${rule.yearDay || '?'} 号`;
  return rule.frequency;
}

// 新建定期账单时的初始表单
function emptyRecurring() {
  return {
    ...emptyBill(),
    frequency: 'monthly',
    intervalDays: 1,
    weekdays: [1],
    // 每月几号单独填，不再跟着开始日期的日号走
    monthDay: Number(nowLocal().slice(8, 10)),
    startDate: nowLocal().slice(0, 10),
    endDate: '',
    time: '09:00',
  };
}

function Recurring() {
  const books = useBooks();
  const { bookQuery } = books;
  const shared = !!books.currentBook && books.currentBook.kind !== 'personal';
  const [rules, setRules] = useState([]);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyRecurring());
  async function load() {
    const data = await api(`/api/recurring?${bookQuery}`);
    setRules(data.rules);
  }
  useEffect(() => { load().catch((err) => setError(err.message)); }, [bookQuery]);
  async function submit(event) {
    event.preventDefault();
    setError('');
    const body = {
      ...form,
      accountId: form.accountId ? Number(form.accountId) : null,
      toAccountId: form.toAccountId ? Number(form.toAccountId) : null,
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      monthDay: Number(form.monthDay) || Number(form.startDate.slice(8, 10)),
      yearMonth: Number(form.startDate.slice(5, 7)),
      yearDay: Number(form.startDate.slice(8, 10)),
    };
    try {
      if (editingId) {
        await api(`/api/recurring/${editingId}`, { method: 'PATCH', body });
      } else {
        await api('/api/recurring', { method: 'POST', body: { ...body, bookId: books.currentBookId || null } });
      }
      cancelEdit();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  function cancelEdit() {
    setEditingId(null);
    setForm(emptyRecurring());
  }
  // 点编辑把规则回填表单，改完走 PATCH
  function editRule(rule) {
    setEditingId(rule.id);
    setForm({
      ...emptyRecurring(),
      type: rule.type,
      amount: rule.amount,
      accountId: rule.accountId ? String(rule.accountId) : '',
      toAccountId: rule.toAccountId ? String(rule.toAccountId) : '',
      categoryId: rule.categoryId ? String(rule.categoryId) : '',
      payee: rule.payee || '',
      note: rule.note || '',
      frequency: rule.frequency,
      intervalDays: rule.intervalDays || 1,
      weekdays: rule.weekdays?.length ? rule.weekdays.map(Number) : [1],
      monthDay: rule.monthDay || Number(nowLocal().slice(8, 10)),
      startDate: rule.startDate || nowLocal().slice(0, 10),
      endDate: rule.endDate || '',
      time: rule.time || '09:00',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function toggleDay(day) {
    const set = new Set(form.weekdays);
    if (set.has(day)) set.delete(day);
    else set.add(day);
    setForm({ ...form, weekdays: [...set].sort() });
  }
  const editing = rules.find((rule) => rule.id === editingId) || null;
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
          <h1>定期</h1>
        </div>
      </div>
      <form className="card stack recurring-form" onSubmit={submit}>
        {error && <div className="error">{error}</div>}
        {editing && (
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span className="tiny muted">
              正在修改「{editing.payee || editing.note || ruleSchedule(editing)}」· 已入账的历史账单不动，只影响下一次及以后
            </span>
            <button className="secondary small" type="button" onClick={cancelEdit}>取消修改</button>
          </div>
        )}
        <BookFields
          form={form}
          setForm={setForm}
          accounts={shared ? [{ id: '', name: '不填账户（共享账本）' }, ...books.accounts] : books.accounts}
          categories={books.categories}
          showTime={false}
        />
        <div className="form-row wrap">
          <label>周期
            <AppSelect value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              {FREQS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </AppSelect>
          </label>
          {form.frequency === 'interval' && (
            <label>间隔天数<input type="number" min="1" value={form.intervalDays} onChange={(e) => setForm({ ...form, intervalDays: Number(e.target.value) })} /></label>
          )}
          {form.frequency === 'monthly' && (
            <label title="固定每月这一天入账；当月没有这一天时（比如 31 号遇到小月）记在当月最后一天">每月几号
              <input
                type="number"
                min="1"
                max="31"
                value={form.monthDay}
                onChange={(e) => setForm({ ...form, monthDay: Number(e.target.value) })}
                required
              />
            </label>
          )}
          <label>开始<input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required /></label>
          <label>结束<input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>
          <label>时刻<input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
        </div>
        {form.frequency === 'weekly' && (
          <div className="checks">
            {WEEKDAYS.map((name, index) => (
              <label key={name}><input type="checkbox" checked={form.weekdays.includes(index + 1)} onChange={() => toggleDay(index + 1)} />周{name}</label>
            ))}
          </div>
        )}
        <div className="row">
          <button className="primary" type="submit">{editingId ? '保存修改' : '保存定期账单'}</button>
          {editingId && <button className="secondary" type="button" onClick={cancelEdit}>取消</button>}
        </div>
      </form>
      <div className="card" style={{ marginTop: 12 }}>
        {rules.map((rule) => (
          <div className={`item${editingId === rule.id ? ' picked' : ''}`} key={rule.id}>
            <div>
              <div>{rule.payee || rule.note || ruleSchedule(rule)} · {money(rule.amount)}</div>
              <div className="tiny muted">{rule.paused ? '已暂停' : `下次 ${rule.nextRun || '已结束'}`} · {ruleSchedule(rule)}{rule.endDate ? ` · ${rule.startDate} 至 ${rule.endDate}` : ` · ${rule.startDate} 起`}</div>
            </div>
            <div className="row">
              <button className="secondary" type="button" onClick={() => editRule(rule)}>编辑</button>
              <button className="secondary" type="button" onClick={async () => { await api(`/api/recurring/${rule.id}`, { method: 'PATCH', body: { paused: !rule.paused } }); await load(); }}>{rule.paused ? '恢复' : '暂停'}</button>
              <button className="danger" type="button" onClick={async () => { await api(`/api/recurring/${rule.id}`, { method: 'DELETE' }); await load(); }}>删除</button>
            </div>
          </div>
        ))}
        {rules.length === 0 && <p className="muted">还没有定期账单。到开始日期为止的账单会自动补记。</p>}
      </div>
    </>
  );
}

const MAP_FIELDS = [
  ['date', '时间'],
  ['amount', '金额'],
  ['type', '收/支'],
  ['category', '分类'],
  ['subcategory', '二级分类'],
  ['account', '账户'],
  ['toAccount', '转入账户'],
  ['payee', '对方'],
  ['note', '备注'],
  // 出游/家庭账本的「付款人」，导入后记在这笔账单的成员上
  ['member', '付款人'],
  // 分摊人：这笔摊给谁，留空 = 按账本参与人平分，写「自己」= 请客不算 AA
  ['share', '分摊人'],
  ['externalId', '单号'],
];

// 导入预览里「只留银行卡渠道」的快捷筛选项，以及判断账户名是不是银行卡
const BANK_CHANNEL = '__bank__';
const BANK_CHANNEL_RE = /银行|信用卡|储蓄卡|借记卡|贷记卡/;

// 银行卡流水里的第三方支付：招行 PDF 的「客户摘要」会写「财付通-微信支付-xxx」这类，
// 这些消费在微信/支付宝账单里也有一条，导入银行卡时可以整批剔掉，只留真正刷卡的部分。
const THIRD_PARTY_CHANNELS = [
  ['wechat', '微信（财付通）', /财付通|微信支付|微信转账|微信红包|微信/],
  ['alipay', '支付宝', /支付宝|蚂蚁|alipay|花呗|网商/i],
  ['jd', '京东', /京东|网银在线/],
];

const CHANNEL_LABELS = { wechat: '微信', alipay: '支付宝', jd: '京东', none: '银行卡' };

function thirdPartyChannel(row) {
  const text = `${row.payee || ''} ${row.note || ''}`;
  for (const [key, , pattern] of THIRD_PARTY_CHANNELS) {
    if (pattern.test(text)) return key;
  }
  return '';
}

const IMPORT_SOURCES = {
  wechat: '微信',
  alipay: '支付宝',
  jd: '京东',
  qianji: '钱迹',
  cmb: '招商银行',
  custom: '自定义',
};

function SkippedRows({ file, onClose }) {
  const skipped = (file.rows || []).filter((row) => row.skipReason);
  const reasons = [];
  for (const row of skipped) {
    const found = reasons.find((item) => item.reason === row.skipReason);
    if (found) found.count += 1;
    else reasons.push({ reason: row.skipReason, count: 1 });
  }
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const unlock = lockPageScroll();
    return () => {
      document.removeEventListener('keydown', onKey);
      unlock();
    };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide stack" role="dialog" aria-modal="true" aria-labelledby="skip-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="skip-title">跳过 {skipped.length} 笔</h2>
        <p className="clip">{file.filename}</p>
        <p className="muted">这些行不会写入账本。交易失败、关闭、取消，或者时间、类型、金额读不出来，才会跳过。退款按收入导入。转给别人记为支出，别人转来记为收入，自己的账户互转不计收支。</p>
        <div className="checks">
          {reasons.map((item) => <span className="tag" key={item.reason}>{item.reason} {item.count}</span>)}
        </div>
        <div className="preview">
          <table>
            <thead><tr><th>时间</th><th>对方</th><th>金额</th><th>原因</th><th>说明</th></tr></thead>
            <tbody>
              {skipped.map((row, index) => (
                <tr key={`${row.externalId || row.occurredAt}-${index}`}>
                  <td>{row.occurredAt || '—'}</td>
                  <td>{row.payee || '—'}</td>
                  <td>{row.amount || '—'}</td>
                  <td>{row.skipReason}</td>
                  <td className="muted clip wide">{row.note || row.categoryName || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button className="primary" type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function importBatchStats(rows, picked, accounts, categories, previewNew) {
  if (previewNew) {
    let expense = 0;
    let income = 0;
    let neutral = 0;
    rows.forEach((row, index) => {
      if (!picked[index] || row.skipReason) return;
      if (row.type === 'expense') expense += 1;
      else if (row.type === 'income') income += 1;
      else if (row.type === 'transfer') neutral += 1;
    });
    return {
      accounts: previewNew.accounts.length,
      categories: previewNew.categories.length,
      newAccounts: previewNew.accounts,
      newCategories: previewNew.categories,
      expense,
      income,
      neutral,
    };
  }
  const accountNames = new Set(accounts.map((item) => item.name));
  const categoryNames = new Set(categories.map((item) => `${item.kind}\0${item.name}`));
  const newAccounts = new Set();
  const newCategories = new Set();
  let expense = 0;
  let income = 0;
  let neutral = 0;
  rows.forEach((row, index) => {
    if (!picked[index] || row.skipReason) return;
    if (row.type === 'expense') expense += 1;
    else if (row.type === 'income') income += 1;
    else if (row.type === 'transfer') neutral += 1;
    const names = [];
    if ((row.accountName || '').trim()) names.push(row.accountName.trim());
    if ((row.toAccountName || '').trim()) names.push(row.toAccountName.trim());
    if (row.type === 'transfer' && row.incoming) names.push((row.payee || '外部').trim());
    names.forEach((name) => {
      if (name && !accountNames.has(name)) newAccounts.add(name);
    });
    if (row.type !== 'expense' && row.type !== 'income') return;
    const parent = (row.categoryName || '').trim();
    const child = (row.subcategoryName || '').trim();
    const leaf = child || parent || '其他';
    if (child && parent) newCategories.add(`${row.type}\0${parent}`);
    newCategories.add(`${row.type}\0${leaf}`);
  });
  categoryNames.forEach((key) => newCategories.delete(key));
  return {
    accounts: newAccounts.size,
    categories: newCategories.size,
    expense,
    income,
    neutral,
  };
}

function ImportPage() {
  const books = useBooks();
  const [source, setSource] = useState('auto');
  const [files, setFiles] = useState([]);
  const [parsed, setParsed] = useState([]);
  const [pending, setPending] = useState([]);
  const [mapping, setMapping] = useState({});
  const [picked, setPicked] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [skippedFile, setSkippedFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [previewNew, setPreviewNew] = useState(null);
  const [page, setPage] = useState(0);
  // 导入前先按「支付方式」筛一遍：微信/支付宝/京东账单里只有一部分是走银行卡付的，
  // 只想留这部分时在这里选，列表只显示并只勾选它。
  const [payFilter, setPayFilter] = useState('');
  // 银行卡流水里的第三方支付：这些和微信/支付宝账单重复，导入银行卡 PDF 时可以整批剔掉
  const [channelFilter, setChannelFilter] = useState('');
  const rows = parsed.flatMap((file) => file.rows || []);
  const readyCount = rows.filter((row, index) => picked[index] && !row.skipReason).length;
  const pageSize = 80;
  // 本次文件里出现过的支付方式，按笔数从多到少排
  const payOptions = (() => {
    const map = new Map();
    for (const row of rows) {
      if (row.skipReason) continue;
      const key = row.accountName || '—';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count);
  })();
  const bankCount = rows.filter((row) => !row.skipReason && BANK_CHANNEL_RE.test(row.accountName || '')).length;
  const channelCounts = { wechat: 0, alipay: 0, jd: 0, none: 0 };
  for (const row of rows) {
    if (row.skipReason) continue;
    channelCounts[thirdPartyChannel(row) || 'none'] += 1;
  }
  // 银行卡流水才需要区分第三方支付：认来源，也认内容里有没有微信/支付宝/京东字样
  const hasBankFile = parsed.some((file) => file.source === 'cmb')
    || channelCounts.wechat + channelCounts.alipay + channelCounts.jd > 0;
  // 出游账本表格才有付款人，普通账单没这一列就不显示，省得占宽度
  const hasMemberFile = rows.some((row) => row.memberName);
  // 分摊人同理：只有表里带了这一列才显示
  const hasShareFile = rows.some((row) => Array.isArray(row.shareWith));
  const shareText = (row) => {
    if (!Array.isArray(row.shareWith)) return '';
    return row.shareWith.length ? row.shareWith.join('、') : '自己承担';
  };
  function matchesPay(row, value) {
    if (!value) return true;
    if (value === BANK_CHANNEL) return BANK_CHANNEL_RE.test(row.accountName || '');
    return (row.accountName || '—') === value;
  }
  function matchesChannel(row, value) {
    if (!value) return true;
    const kind = thirdPartyChannel(row);
    return value === 'none' ? !kind : kind === value;
  }
  function applyFilter(nextPay, nextChannel) {
    setPayFilter(nextPay);
    setChannelFilter(nextChannel);
    const next = {};
    rows.forEach((row, index) => {
      next[index] = !row.skipReason && matchesPay(row, nextPay) && matchesChannel(row, nextChannel);
    });
    setPicked(next);
    setPage(0);
  }
  const shownRows = [];
  rows.forEach((row, index) => {
    if (matchesPay(row, payFilter) && matchesChannel(row, channelFilter)) shownRows.push({ row, index });
  });
  const pageCount = Math.max(1, Math.ceil(shownRows.length / pageSize));
  const pageStart = Math.min(page, pageCount - 1) * pageSize;
  const visibleRows = shownRows.slice(pageStart, pageStart + pageSize).map((item) => item.row);
  const visibleIndexes = shownRows.slice(pageStart, pageStart + pageSize).map((item) => item.index);
  const batchStats = useMemo(
    () => importBatchStats(rows, picked, books.accounts, books.categories, previewNew),
    [rows, picked, books.accounts, books.categories, previewNew],
  );

  function takeParsed(data, uploaded, replacePending) {
    setPreviewNew(
      data.newAccounts && data.newCategories
        ? { accounts: data.newAccounts, categories: data.newCategories }
        : null,
    );
    const nextPending = [];
    const nextParsed = [];
    data.files.forEach((file, index) => {
      if (file.needsMapping) nextPending.push({ ...file, file: uploaded[index] });
      else nextParsed.push(file);
    });
    // 文件之间按文件名排（中文按拼音序）；每个文件内部按时间由近到远，
    // 账单文件原始顺序是从最早开始，翻起来不方便
    const merged = (replacePending ? nextParsed : [...parsed, ...nextParsed])
      .map((file) => ({
        ...file,
        rows: (file.rows || []).slice().sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || ''))),
      }))
      .sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || ''), 'zh-CN'));
    const queued = replacePending ? nextPending : [...pending.slice(1), ...nextPending];
    setParsed(merged);
    setPending(queued);
    // 出游账本这类表格没有「收/支」列，默认按支出解析，解析页里还能改
    setMapping({ defaultType: 'expense', ...(queued[0]?.suggested || {}) });
    const flat = merged.flatMap((file) => file.rows || []);
    setPicked(Object.fromEntries(flat.map((row, index) => [index, !row.skipReason])));
    setPayFilter('');
    setChannelFilter('');
    setPage(0);
  }

  async function parseUploads(list, nextMapping, replacePending) {
    setParsing(true);
    setError('');
    setMessage('');
    try {
      const body = new FormData();
      list.forEach((file) => body.append('files', file));
      body.append('source', nextMapping ? 'custom' : source);
      if (nextMapping) body.append('mapping', JSON.stringify(nextMapping));
      const data = await api('/api/import/preview', { method: 'POST', body });
      takeParsed(data, list, replacePending);
    } finally {
      setParsing(false);
    }
  }

  async function commit() {
    setCommitting(true);
    setError('');
    try {
      const selected = rows.filter((row, index) => picked[index] && !row.skipReason);
      const result = await api('/api/import/commit', { method: 'POST', body: { rows: selected, bookId: books.currentBookId } });
      setMessage(`导入 ${result.inserted} 笔，重复 ${result.duplicated} 笔，失败 ${result.failed} 笔。`);
      setParsed([]);
      setFiles([]);
      setPicked({});
    } finally {
      setCommitting(false);
    }
  }

  async function downloadTemplate(kind) {
    setError('');
    try {
      const response = await fetch(apiUrl(`/api/import/template?kind=${kind}`), {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!response.ok) throw new Error('模板下载失败');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = kind === 'travel' ? '出游账本导入模板.xlsx' : '账单导入模板.xlsx';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

  const mappingFile = pending[0];
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '个人账本'}</span>
          <h1>导入</h1>
        </div>
      </div>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); parseUploads(files, null, true).catch((err) => setError(err.message)); }}>
        {error && <div className="error">{error}</div>}
        {message && <p>{message}</p>}
        <label>来源
          <AppSelect value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="auto">自动识别</option>
            <option value="wechat">微信</option>
            <option value="alipay">支付宝</option>
            <option value="jd">京东</option>
            <option value="qianji">钱迹</option>
            <option value="cmb">招商银行</option>
            <option value="custom">自定义</option>
          </AppSelect>
        </label>
        <label>文件
          <input type="file" accept=".csv,.xlsx,.xls,.txt,.pdf" multiple onChange={(e) => setFiles([...(e.target.files || [])])} required={!files.length} />
        </label>
        {files.length > 0 && <p className="muted">已选 {files.length} 个文件：{files.map((file) => file.name).join('、')}</p>}
        {parsing && <p className="loading">正在解析账单…</p>}
        <button className="primary" type="submit" disabled={!files.length || parsing}>{parsing ? '解析中…' : '解析账单'}</button>
        <div className="row">
          <button className="secondary" type="button" onClick={() => downloadTemplate('travel')}>下载出游账本模板</button>
          <button className="secondary" type="button" onClick={() => downloadTemplate('custom')}>下载通用账单模板</button>
          <span className="muted">出游模板带「付款人」「分摊人」列：分摊人留空 = 按账本参与人平分，写「自己」= 这笔请客不算 AA。</span>
        </div>
      </form>
      {mappingFile && (
        <form className="card stack" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); parseUploads([mappingFile.file], mapping, false).catch((err) => setError(err.message)); }}>
          <h2>映射 {mappingFile.filename}</h2>
          <p className="muted">还有 {pending.length} 个文件需要指定字段。{pending.length > 1 ? '映射完这个会继续下一个。' : ''}</p>
          {/* 宽屏两列，手机上自动塌成一列 */}
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            {MAP_FIELDS.map(([field, label]) => (
              <label key={field}>{label}
                <AppSelect value={mapping[field] || ''} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}>
                  <option value="">不映射</option>
                  {mappingFile.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                </AppSelect>
              </label>
            ))}
          </div>
          <label>没有「收/支」列时全部记为
            <AppSelect value={mapping.defaultType || 'expense'} onChange={(e) => setMapping({ ...mapping, defaultType: e.target.value })}>
              <option value="expense">支出</option>
              <option value="income">收入</option>
            </AppSelect>
          </label>
          {parsing && <p className="loading">正在按映射解析…</p>}
          <button className="primary" type="submit" disabled={parsing}>{parsing ? '解析中…' : '按映射解析'}</button>
        </form>
      )}
      {parsed.length > 0 && (
        <section className="card" style={{ marginTop: 12 }}>
          <div className="page-head">
            <h2>可导入 {readyCount} / {rows.length}</h2>
            <div className="row import-actions">
              <button className="primary" type="button" disabled={!readyCount || committing || parsing} onClick={() => commit().catch((err) => setError(err.message))}>{committing ? '导入中…' : '导入选中'}</button>
              <p
                className="import-stat"
                title={[
                  ...(batchStats.newAccounts || []).map((n) => `新账户 ${n}`),
                  ...(batchStats.newCategories || []).map((n) => `新分类 ${n}`),
                ].join('；')}
              >
                本次新增账户 {books.ready ? batchStats.accounts : '—'}，新增类别 {books.ready ? batchStats.categories : '—'}，支出共 {batchStats.expense} 笔，收入共 {batchStats.income} 笔，不计收支 {batchStats.neutral} 笔
              </p>
            </div>
          </div>
          <div className="list">
            {parsed.map((file, index) => (
              <div className="item" key={`${file.filename}-${index}`}>
                <span className="clip">{file.filename} <span className="tag">{IMPORT_SOURCES[file.source] || file.source || ''}</span></span>
                <span className="muted">
                  {file.error || (
                    <>
                      可导入 {file.ready}
                      {file.skipped > 0
                        ? <>，<button className="text-button" type="button" onClick={() => setSkippedFile(file)}>跳过 {file.skipped}</button></>
                        : '，跳过 0'}
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="search-row" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', margin: '8px 0' }}>
            {/* 银行卡流水的支付方式全是同一个（招商银行），按它筛没意义，这时只留渠道下拉 */}
            {(!hasBankFile || payOptions.length > 1) && (
              <label>只导入支付方式
                <AppSelect value={payFilter} onChange={(e) => applyFilter(e.target.value, channelFilter)}>
                  <option value="">全部（{rows.filter((row) => !row.skipReason).length} 笔）</option>
                  {bankCount > 0 && <option value={BANK_CHANNEL}>银行卡渠道（{bankCount} 笔）</option>}
                  {payOptions.map((item) => (
                    <option key={item.name} value={item.name}>{item.name}（{item.count} 笔）</option>
                  ))}
                </AppSelect>
              </label>
            )}
            {hasBankFile && (
              <label>银行卡里的第三方支付
                <AppSelect value={channelFilter} onChange={(e) => applyFilter(payFilter, e.target.value)}>
                  <option value="">全部（{rows.filter((row) => !row.skipReason).length} 笔）</option>
                  <option value="none">只留纯银行卡，排除微信/支付宝/京东（{channelCounts.none} 笔）</option>
                  {THIRD_PARTY_CHANNELS.map(([key, label]) => (
                    <option key={key} value={key}>只看{label}（{channelCounts[key]} 笔）</option>
                  ))}
                </AppSelect>
              </label>
            )}
            {(payFilter || channelFilter) && (
              <>
                <span className="muted">列表剩 {shownRows.filter((item) => !item.row.skipReason).length} 笔，已勾选 {readyCount} 笔</span>
                <button className="secondary" type="button" onClick={() => applyFilter('', '')}>恢复全选</button>
              </>
            )}
          </div>
          <div className="preview">
            <table>
              <thead><tr><th></th><th>文件</th><th>时间</th><th>类型</th><th>金额</th>{hasMemberFile && <th>付款人</th>}{hasShareFile && <th>分摊人</th>}<th>对方</th><th>支付方式</th>{hasBankFile && <th>渠道</th>}<th>说明</th></tr></thead>
              <tbody>
                {visibleRows.map((row, index) => {
                  const rowIndex = visibleIndexes[index];
                  return (
                    <tr key={`${row.filename}-${rowIndex}`}>
                      <td><input type="checkbox" disabled={!!row.skipReason} checked={!!picked[rowIndex]} onChange={(e) => setPicked({ ...picked, [rowIndex]: e.target.checked })} /></td>
                      <td className="clip">{row.filename}</td>
                      <td>{row.occurredAt}</td>
                      <td>{TYPES.find((item) => item[0] === row.type)?.[1] || ''}</td>
                      <td>{row.amount}</td>
                      {hasMemberFile && <td>{row.memberName}</td>}
                      {hasShareFile && <td>{shareText(row)}</td>}
                      <td>{row.payee}</td>
                      <td>{row.accountName}</td>
                      {hasBankFile && <td>{CHANNEL_LABELS[thirdPartyChannel(row) || 'none']}</td>}
                      <td className="muted clip wide">{row.skipReason || row.note || row.categoryName || row.categoryLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {shownRows.length > pageSize && (
            <div className="row pager">
              <button className="secondary" type="button" disabled={pageStart === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button>
              <span className="muted">{pageStart + 1}–{Math.min(pageStart + pageSize, shownRows.length)} / {shownRows.length}</span>
              <button className="secondary" type="button" disabled={pageStart + pageSize >= shownRows.length} onClick={() => setPage((current) => current + 1)}>下一页</button>
            </div>
          )}
        </section>
      )}
      {skippedFile && <SkippedRows file={skippedFile} onClose={() => setSkippedFile(null)} />}
    </>
  );
}

function AccountsPage() {
  const { accounts, reload } = useBooks();
  const [account, setAccount] = useState({ name: '', kind: 'cash', initial: '0' });
  const [merge, setMerge] = useState({ sourceId: '', targetId: '' });
  const [alias, setAlias] = useState({ alias: '', accountId: '' });
  const [aliases, setAliases] = useState([]);
  const [mergeModal, setMergeModal] = useState(null);
  const [error, setError] = useState('');
  useScrollLock(!!mergeModal);

  const primary = accounts.filter((a) => !a.mergedInto);
  const mergedOf = (id) => accounts.filter((a) => a.mergedInto === id);

  async function loadAliases() {
    const data = await api('/api/account-aliases').catch(() => ({ aliases: [] }));
    setAliases(data.aliases || []);
  }
  useEffect(() => { loadAliases(); }, []);

  async function run(fn) {
    setError('');
    try {
      await fn();
      await Promise.all([reload(), loadAliases()]);
    } catch (err) { setError(err.message); }
  }

  function addAccount(event) {
    event.preventDefault();
    run(async () => {
      await api('/api/accounts', { method: 'POST', body: account });
      setAccount({ name: '', kind: 'cash', initial: '0' });
    });
  }

  return (
    <>
      <div className="page-head"><h1>账户</h1></div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="grid cards">
        <section className="card">
          <h2>账户</h2>
          <form className="stack" onSubmit={addAccount}>
            <div className="form-row">
              <label>名称<input value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} required /></label>
              <label>类型
                <AppSelect value={account.kind} onChange={(e) => setAccount({ ...account, kind: e.target.value })}>
                  {ACCOUNT_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </AppSelect>
              </label>
              <label>初始余额<input value={account.initial} onChange={(e) => setAccount({ ...account, initial: e.target.value })} /></label>
            </div>
            <button className="primary" type="submit">添加账户</button>
          </form>
          {primary.map((item) => (
            <div className="account" key={item.id}>
              <div className="account-main">
                <div className="account-name">{item.name} <span className="tag">{item.archived ? '已归档' : ACCOUNT_KINDS.find((k) => k[0] === item.kind)?.[1]}</span></div>
                <div className="account-balance">{money(item.balance)}</div>
              </div>
              <div className="account-actions">
                {mergedOf(item.id).length > 0 ? (
                  <button
                    type="button"
                    className="tiny muted"
                    style={{ padding: 0, border: 'none', background: 'none', textDecoration: 'underline', cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => setMergeModal(item.id)}
                  >
                    已合并 {mergedOf(item.id).length} 个账户
                  </button>
                ) : <span />}
                <button className="secondary" type="button" onClick={() => run(() => api(`/api/accounts/${item.id}`, { method: 'PATCH', body: { archived: !item.archived } }))}>{item.archived ? '恢复' : '归档'}</button>
              </div>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>账户归并</h2>
          <p className="muted">把一个账户归到另一个账户下，导入和统计都按同一个账户算。归并后账单里的旧名字会自动认成目标账户。</p>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/api/accounts/merge', { method: 'POST', body: { sourceId: Number(merge.sourceId), targetId: Number(merge.targetId) } }); setMerge({ sourceId: '', targetId: '' }); }); }}>
            <label>要归并的账户
              <AppSelect value={merge.sourceId} onChange={(e) => setMerge({ ...merge, sourceId: e.target.value })} required>
                <option value="">请选择</option>
                {accounts.filter((a) => !a.archived || a.mergedInto).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </AppSelect>
            </label>
            <label>归到哪个账户
              <AppSelect value={merge.targetId} onChange={(e) => setMerge({ ...merge, targetId: e.target.value })} required>
                <option value="">请选择</option>
                {primary.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </AppSelect>
            </label>
            <button className="primary" type="submit">归并</button>
          </form>
          <div className="list">
            {accounts.filter((a) => a.mergedInto).map((item) => (
              <div className="item" key={item.id}>
                <div className="tiny">{item.name.replace(/·旧\d+$/, '')} → {primary.find((p) => p.id === item.mergedInto)?.name}</div>
                <button className="secondary" type="button" onClick={() => run(() => api('/api/accounts/unmerge', { method: 'POST', body: { accountId: item.id } }))}>解除</button>
              </div>
            ))}
          </div>
          <h3>账单里的其它叫法</h3>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/api/account-aliases', { method: 'POST', body: { alias: alias.alias, accountId: Number(alias.accountId) } }); setAlias({ alias: '', accountId: '' }); }); }}>
            <div className="form-row">
              <label>叫法<input value={alias.alias} onChange={(e) => setAlias({ ...alias, alias: e.target.value })} placeholder="余额&红包" required /></label>
              <label>对应账户
                <AppSelect value={alias.accountId} onChange={(e) => setAlias({ ...alias, accountId: e.target.value })} required>
                  <option value="">请选择</option>
                  {primary.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </AppSelect>
              </label>
            </div>
            <button className="primary" type="submit">添加</button>
          </form>
          <div className="list">
            {aliases.map((item) => (
              <div className="item" key={item.id}>
                <div className="tiny">{item.alias} → {item.account_name}</div>
                <button className="secondary" type="button" onClick={() => run(() => api(`/api/account-aliases/${item.id}`, { method: 'DELETE' }))}>删除</button>
              </div>
            ))}
          </div>
        </section>

      </div>
      {mergeModal && createPortal(
        <div className="modal-backdrop" onClick={() => setMergeModal(null)}>
          <div className="modal stack" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h2>{primary.find((a) => a.id === mergeModal)?.name} 的合并账户</h2>
            <div className="list">
              {mergedOf(mergeModal).map((m) => (
                <div className="item" key={m.id}>
                  <div className="tiny">{m.name.replace(/·旧\d+$/, '')}</div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => run(() => api('/api/accounts/unmerge', { method: 'POST', body: { accountId: m.id } }))}
                  >
                    解除
                  </button>
                </div>
              ))}
            </div>
            {!mergedOf(mergeModal).length && <p className="muted">已没有合并账户</p>}
            <div className="modal-actions">
              <button className="primary" type="button" onClick={() => setMergeModal(null)}>关闭</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function CategoriesPage() {
  const { categories, reload } = useBooks();
  const [kind, setKind] = useState('expense');
  const [adding, setAdding] = useState(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [rules, setRules] = useState([]);
  const [ruleKeyword, setRuleKeyword] = useState('');
  const [ruleCategoryId, setRuleCategoryId] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    api('/api/category-rules').then((data) => setRules(data.rules || [])).catch(() => {});
  }, []);

  function reloadRules() {
    return api('/api/category-rules').then((data) => setRules(data.rules || []));
  }

  const mine = categories.filter((c) => c.kind === kind);
  const tops = mine.filter((c) => !c.archived && !c.parentId);
  const childrenOf = (id) => mine.filter((c) => !c.archived && c.parentId === id);
  const archived = mine.filter((c) => c.archived);

  function run(action, ok) {
    setError('');
    setNotice('');
    action()
      .then((result) => { reload(); if (ok) setNotice(ok(result)); })
      .catch((err) => setError(err.message));
  }

  function submitAdd(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !adding) return;
    run(
      () => api('/api/categories', { method: 'POST', body: { name: trimmed, kind, parentId: adding.parentId } }),
      () => { setAdding(null); setName(''); return ''; },
    );
  }

  function submitEdit(event, item) {
    event.preventDefault();
    const trimmed = editing.name.trim();
    if (!trimmed) return;
    run(
      () => api(`/api/categories/${item.id}`, { method: 'PATCH', body: { name: trimmed } }),
      () => { setEditing(null); return ''; },
    );
  }

  function remove(item) {
    const label = item.parentId ? '删除' : '归档';
    setConfirm({
      item,
      label,
      body: item.parentId
        ? '删除后，归属到该分类的历史账单会显示为「未分类」。'
        : '该分类下的二级分类会一起处理；有账单在用的分类会被归档，不会丢失历史账单。',
      onConfirm: () => {
        setConfirm(null);
        run(
          () => api(`/api/categories/${item.id}`, { method: 'DELETE' }),
          (result) => (result.archived ? `「${item.name}」还有账单在用，已归档` : `已删除「${item.name}」`),
        );
      },
    });
  }

  function restore(item) {
    run(
      () => api(`/api/categories/${item.id}`, { method: 'PATCH', body: { archived: false } }),
      () => `已恢复「${item.name}」`,
    );
  }

  function purge(item) {
    setConfirm({
      title: `彻底删除「${item.name}」？`,
      body: '已归档的分类会直接从库里删掉。如果它（或它的子分类）还有账单在用，则只能保持归档，不会真删。',
      confirmLabel: '删除',
      onConfirm: () => {
        setConfirm(null);
        run(
          () => api(`/api/categories/${item.id}`, { method: 'DELETE' }),
          (result) => (result.archived ? `「${item.name}」还有账单在用，只能保持归档` : `已彻底删除「${item.name}」`),
        );
      },
    });
  }

  function prune() {
    setConfirm({
      title: `清理 ${archived.length} 个已归档分类？`,
      body: '没有账单在用的会被彻底删除；有账单在用的会保留归档状态，历史账单不受影响。',
      confirmLabel: '清理',
      onConfirm: () => {
        setConfirm(null);
        run(
          () => api('/api/categories/prune', { method: 'POST' }),
          (result) => `已彻底删除 ${result.deleted} 个，保留 ${result.kept} 个（还有账单在用）`,
        );
      },
    });
  }

  function addRule(event) {
    event.preventDefault();
    const keyword = ruleKeyword.trim();
    if (!keyword || !ruleCategoryId) return;
    setError('');
    setNotice('');
    api('/api/category-rules', { method: 'POST', body: { keyword, categoryId: Number(ruleCategoryId) } })
      .then((result) => { setRuleKeyword(''); return reloadRules().then(() => result); })
      .then((result) => setNotice(result.updated
        ? `已添加规则：含「${keyword}」→ 指定分类，并归类了 ${result.updated} 笔未分类账单`
        : `已添加规则：含「${keyword}」→ 指定分类（现有未分类账单里没有命中的）`))
      .catch((err) => setError(err.message));
  }

  function removeRule(rule) {
    setError('');
    setNotice('');
    api(`/api/category-rules/${rule.id}`, { method: 'DELETE' })
      .then(reloadRules)
      .then(() => setNotice(`已删除规则「${rule.keyword}」`))
      .catch((err) => setError(err.message));
  }

  function applyRules() {
    setError('');
    setNotice('');
    setApplying(true);
    api('/api/category-rules/apply', { method: 'POST', body: { dryRun: true } })
      .then((result) => {
        setApplying(false);
        if (!result.matched) {
          setNotice('现有未分类的账单里，没有能被规则命中的。');
          return;
        }
        setConfirm({
          title: `给 ${result.matched} 笔未分类账单套用规则？`,
          body: '只补还没有分类的账单，已经分好的不会被改动。',
          confirmLabel: '套用',
          onConfirm: () => {
            setConfirm(null);
            run(
              () => api('/api/category-rules/apply', { method: 'POST' }),
              (done) => `已归类 ${done.updated} 笔`,
            );
          },
        });
      })
      .catch((err) => { setApplying(false); setError(err.message); });
  }

  // 同名重复分类：导入时重复创建的，合并后账单自动指向保留的那个
  const duplicateNames = (() => {
    const map = new Map();
    for (const item of categories) {
      const key = `${item.kind}\0${item.name}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].filter(([, count]) => count > 1).map(([key]) => key.split('\0')[1]);
  })();

  function mergeDuplicates() {
    setConfirm({
      title: `合并 ${duplicateNames.length} 个重名分类？`,
      body: `${duplicateNames.join('、')} 各有多个。合并后账单和子分类都归到保留的那个，重复的会被删除，历史账单不受影响。`,
      confirmLabel: '合并',
      onConfirm: () => {
        setConfirm(null);
        run(
          () => api('/api/categories/merge-duplicates', { method: 'POST' }),
          (result) => `已合并 ${result.merged} 个重名分类，${result.moved} 笔账单改指向保留的分类`,
        );
      },
    });
  }

  function startEdit(item) {
    setAdding(null);
    setEditing({ id: item.id, name: item.name });
  }

  function editForm(item, placeholder) {
    return (
      <form className="cat-edit" onSubmit={(e) => submitEdit(e, item)}>
        <input autoFocus value={editing.name} onChange={(e) => setEditing({ id: item.id, name: e.target.value })} placeholder={placeholder} required />
        <button className="primary small" type="submit">保存</button>
        <button className="secondary small" type="button" onClick={() => setEditing(null)}>取消</button>
      </form>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>分类</h1>
        {kind !== 'rules' && (
          <button className="secondary" type="button" onClick={() => { setAdding({ parentId: null }); setName(''); }}>新增一级分类</button>
        )}
        {duplicateNames.length > 0 && (
          <button className="secondary" type="button" onClick={mergeDuplicates}>合并 {duplicateNames.length} 个重名分类</button>
        )}
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <p className="muted" style={{ marginBottom: 12 }}>{notice}</p>}
      <div className="split">
        <nav className="side-tabs">
          {[['expense', '支出'], ['income', '收入'], ['rules', '自动分类']].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={value === kind ? 'active' : ''}
              onClick={() => { setKind(value); setAdding(null); setEditing(null); setName(''); }}
            >
              {label}
            </button>
          ))}
        </nav>
        <section className="card">
          {kind === 'rules' ? (
            <>
              <div className="tree-head">
                <h2>自动分类规则</h2>
              </div>
              <p className="muted">账单的「对方」或「备注」里含关键词，就自动归到指定分类。导入新账单时立刻生效；加规则时也会立刻补一遍已有账单。同一个账单命中多条时，取关键词最长的那条。</p>
              <div className="cat-chips" style={{ marginTop: 10 }}>
                {rules.length === 0 && <span className="muted">还没有规则。比如「美团 → 餐饮」。</span>}
                {rules.map((rule) => (
                  <span className="cat-chip" key={rule.id}>
                    <b>{rule.keyword}</b>
                    <span className="muted">→ {rule.categoryName}</span>
                    <button type="button" className="chip-btn danger" title="删除" onClick={() => removeRule(rule)}>✕</button>
                  </span>
                ))}
              </div>
              <form className="cat-edit" onSubmit={addRule} style={{ marginTop: 12 }}>
                <input value={ruleKeyword} onChange={(e) => setRuleKeyword(e.target.value)} placeholder="关键词，如 美团" required />
                <AppSelect value={ruleCategoryId} onChange={(e) => setRuleCategoryId(e.target.value)} required>
                  <option value="">归到哪个分类</option>
                  {[['expense', '支出'], ['income', '收入']].map(([value, label]) => (
                    <optgroup key={value} label={label}>
                      {categories.filter((c) => !c.archived && c.kind === value).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </AppSelect>
                <button className="primary small" type="submit" disabled={!ruleKeyword.trim() || !ruleCategoryId}>添加规则</button>
                <span className="spacer" />
                <button className="secondary small" type="button" disabled={applying || !rules.length} onClick={applyRules}>
                  {applying ? '检查中…' : '套用到未分类账单'}
                </button>
              </form>
            </>
          ) : (
            <>
          <div className="tree-head">
            <h2>{kind === 'expense' ? '支出分类' : '收入分类'}</h2>
            <button className="secondary small" type="button" onClick={() => { setAdding({ parentId: null }); setName(''); }}>新增一级分类</button>
          </div>
          <div className="cat-list">
            {tops.map((parent) => {
              const children = childrenOf(parent.id);
              return (
                <div className="cat-card" key={parent.id}>
                  <div className="cat-card-head">
                    {editing?.id === parent.id ? (
                      editForm(parent, '一级分类名')
                    ) : (
                      <>
                        <b>{parent.name}</b>
                        <span className="tag">{children.length} 项</span>
                        <span className="spacer" />
                        <button className="secondary small" type="button" onClick={() => startEdit(parent)}>编辑</button>
                        <button className="secondary small" type="button" onClick={() => { setEditing(null); setAdding({ parentId: parent.id }); setName(''); }}>加子分类</button>
                        <button className="danger small" type="button" onClick={() => remove(parent)}>归档</button>
                      </>
                    )}
                  </div>
                  {(children.length > 0 || adding?.parentId === parent.id) && (
                    <div className="cat-chips">
                      {children.map((child) => (
                        editing?.id === child.id ? (
                          <span className="cat-chip editing" key={child.id}>{editForm(child, '二级分类名')}</span>
                        ) : (
                          <span className="cat-chip" key={child.id}>
                            <b>{child.name}</b>
                            <button type="button" className="chip-btn" title="编辑" onClick={() => startEdit(child)}>✎</button>
                            <button type="button" className="chip-btn danger" title="删除" onClick={() => remove(child)}>✕</button>
                          </span>
                        )
                      ))}
                      {adding?.parentId === parent.id && (
                        <form className="cat-edit" onSubmit={submitAdd}>
                          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="二级分类名" required />
                          <button className="primary small" type="submit">添加</button>
                          <button className="secondary small" type="button" onClick={() => setAdding(null)}>取消</button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {tops.length === 0 && <p className="muted">还没有{kind === 'expense' ? '支出' : '收入'}分类。</p>}
            {adding && adding.parentId === null && (
              <form className="cat-edit" onSubmit={submitAdd}>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="一级分类名" required />
                <button className="primary small" type="submit">添加</button>
                <button className="secondary small" type="button" onClick={() => setAdding(null)}>取消</button>
              </form>
            )}
          </div>
          {archived.length > 0 && (
            <div className="cat-archived">
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="secondary small" type="button" onClick={() => setShowArchived((v) => !v)}>
                  已归档 {archived.length} 个{showArchived ? ' ▾' : ' ▸'}
                </button>
                <span className="spacer" />
                {showArchived && (
                  <button className="danger small" type="button" onClick={prune}>清理无账单的</button>
                )}
              </div>
              {showArchived && (
                <div className="cat-chips">
                  {archived.map((item) => (
                    <span className="cat-chip muted" key={item.id}>
                      <b>{item.name}</b>
                      <button type="button" className="chip-btn text" title="恢复" onClick={() => restore(item)}>恢复</button>
                      <button type="button" className="chip-btn danger" title="彻底删除" onClick={() => purge(item)}>✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          <p className="muted" style={{ marginTop: 12 }}>导入的分类会按内置对照表落到这套分类上，认不出来的进「其他」。</p>
            </>
          )}
        </section>
      </div>
      {confirm && (
        <ConfirmModal
          title={confirm.title || `确定${confirm.label}「${confirm.item.name}」？`}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel || `确定${confirm.label}`}
          onClose={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}
    </>
  );
}

// 两笔之间允许相差多少天
const DUP_WINDOWS = [
  [1, '相差 ≤1 天'],
  [3, '≤3 天'],
  [7, '≤7 天'],
];

// 账目范围：钱花在哪个时间段里
const DUP_SCOPES = [
  ['all', '全部'],
  ['year', '近一年'],
  ['3m', '近三个月'],
  ['month', '当月'],
];

function scopeWindow(scope) {
  if (scope === 'all') return { from: '', to: '' };
  const now = new Date();
  const months = scope === 'year' ? 12 : scope === '3m' ? 3 : 1;
  return {
    from: localDate(new Date(now.getFullYear(), now.getMonth() - (months - 1), 1)),
    to: localDate(now),
  };
}

const DUP_LEVELS = [
  [90, '高置信'],
  [80, '默认'],
  [65, '宽松'],
];

function TransferRules() {
  const { accounts } = useBooks();
  const narrow = useNarrow();
  const [rules, setRules] = useState([]);
  const [form, setForm] = useState({ id: null, label: '', pattern: '', isRegex: false, targetAccountId: '', enabled: true });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const accountName = (id) => (accounts.find((a) => a.id === Number(id)) || {}).name || '';
  const accountOptions = accounts.filter((a) => !a.archived && !a.mergedInto);

  function load() {
    return api('/api/transfer-rules').then((data) => setRules(data.rules || []));
  }
  useEffect(() => { load().catch(() => {}); }, []);

  function reset() {
    setForm({ id: null, label: '', pattern: '', isRegex: false, targetAccountId: '', enabled: true });
  }

  function submit(event) {
    event.preventDefault();
    const label = form.label.trim();
    const pattern = form.pattern.trim();
    if (!label || !pattern) return;
    setError('');
    setNotice('');
    const body = {
      label,
      pattern,
      isRegex: form.isRegex,
      targetAccountId: form.targetAccountId ? Number(form.targetAccountId) : null,
      enabled: form.enabled,
    };
    const req = form.id
      ? api(`/api/transfer-rules/${form.id}`, { method: 'PATCH', body })
      : api('/api/transfer-rules', { method: 'POST', body });
    req.then(load)
      .then(() => { reset(); setModalOpen(false); setNotice(form.id ? '已保存' : '已添加规则'); })
      .catch((err) => setError(err.message));
  }

  function editRule(rule) {
    setForm({
      id: rule.id,
      label: rule.label,
      pattern: rule.pattern,
      isRegex: !!rule.is_regex,
      targetAccountId: rule.target_account_id ? String(rule.target_account_id) : '',
      enabled: rule.enabled !== 0,
    });
    setModalOpen(true);
  }

  const ruleForm = (
    <form className="cat-edit" onSubmit={submit} style={{ flexWrap: 'wrap' }}>
      <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="名称，如 信用卡还款" required />
      <input value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder={form.isRegex ? '正则，如 信用卡还款|待清算信用卡' : '关键词，如 信用卡还款'} required />
      <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <input type="checkbox" checked={form.isRegex} onChange={(e) => setForm({ ...form, isRegex: e.target.checked })} /> 正则
      </label>
      <AppSelect value={form.targetAccountId} onChange={(e) => setForm({ ...form, targetAccountId: e.target.value })}>
        <option value="">转入账户（不指定=只判类型）</option>
        {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </AppSelect>
      <button className="primary small" type="submit" disabled={!form.label.trim() || !form.pattern.trim()}>{form.id ? '保存' : '添加规则'}</button>
      <button className="secondary small" type="button" onClick={() => { reset(); setModalOpen(false); }}>取消</button>
    </form>
  );

  function removeRule(rule) {
    setConfirm({
      title: `删除规则「${rule.label}」？`,
      body: '删除后，导入账单时不再按这条规则判定转账。',
      confirmLabel: '删除',
      onConfirm: () => {
        setConfirm(null);
        api(`/api/transfer-rules/${rule.id}`, { method: 'DELETE' })
          .then(load)
          .then(() => setNotice(`已删除规则「${rule.label}」`))
          .catch((err) => setError(err.message));
      },
    });
  }

  function toggleEnabled(rule) {
    api(`/api/transfer-rules/${rule.id}`, { method: 'PATCH', body: { enabled: rule.enabled === 0 } })
      .then(load)
      .catch((err) => setError(err.message));
  }

  return (
    <>
      <div className="page-head">
        <h1>转账规则</h1>
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <p className="muted" style={{ marginBottom: 12 }}>{notice}</p>}
      <p className="muted">
        导入账单时，如果一笔账单的「对方 / 备注 / 分类」里命中下面某条规则，就把它当成「自己的账户 → 自己的账户」的转账。
        可指定转入账户（从你自己的账户里选），不指定则只判类型、不填去向。规则按顺序匹配，命中第一条即生效。
      </p>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="tree-head"><h2>已配置规则</h2></div>
        {rules.length === 0 && <span className="muted">还没有规则。比如「信用卡还款 → 招商银行信用卡」。</span>}
        <div className="cat-chips" style={{ marginTop: 10 }}>
          {rules.map((rule) => (
            <span className="cat-chip rule-chip" key={rule.id}>
              <span className="chip-body">
                <b>{rule.label}</b>
                <span className="muted">
                  匹配 {rule.is_regex ? <code>/{rule.pattern}/</code> : <code>{rule.pattern}</code>}
                </span>
                {rule.target_account_id
                  ? <span className="muted">→ {accountName(rule.target_account_id)}</span>
                  : <span className="muted">（只判类型）</span>}
              </span>
              <span className="chip-actions">
                <label className="switch" title="启用">
                  <input type="checkbox" checked={rule.enabled !== 0} onChange={() => toggleEnabled(rule)} />
                </label>
                <button type="button" className="chip-btn" title="编辑" onClick={() => editRule(rule)}>编辑</button>
                <button type="button" className="chip-btn danger" title="删除" onClick={() => removeRule(rule)}>✕</button>
              </span>
            </span>
          ))}
        </div>
      </div>
      {narrow && (
        <button className="primary" type="button" style={{ marginTop: 12, width: '100%' }} onClick={() => { reset(); setModalOpen(true); }}>新增规则</button>
      )}
      {!narrow && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="tree-head"><h2>{form.id ? '编辑规则' : '新增规则'}</h2></div>
          {ruleForm}
        </div>
      )}
      {narrow && modalOpen && (
        <FormModal title={form.id ? '编辑规则' : '新增规则'} onClose={() => { setModalOpen(false); reset(); }}>
          {ruleForm}
        </FormModal>
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          onClose={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}
    </>
  );
}

function CmbTextFixes() {
  const narrow = useNarrow();
  const [fixes, setFixes] = useState([]);
  const [form, setForm] = useState({ id: null, garbled: '', correct: '', enabled: true });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  function load() {
    return api('/api/cmb-text-fixes').then((data) => setFixes(data.fixes || []));
  }
  useEffect(() => { load().catch(() => {}); }, []);

  function reset() {
    setForm({ id: null, garbled: '', correct: '', enabled: true });
  }

  function submit(event) {
    event.preventDefault();
    const garbled = form.garbled.trim();
    const correct = form.correct.trim();
    if (!garbled) return;
    setError('');
    setNotice('');
    const body = { garbled, correct, enabled: form.enabled };
    const req = form.id
      ? api(`/api/cmb-text-fixes/${form.id}`, { method: 'PATCH', body })
      : api('/api/cmb-text-fixes', { method: 'POST', body });
    req.then(load)
      .then(() => { reset(); setModalOpen(false); setNotice(form.id ? '已保存' : '已添加修复'); })
      .catch((err) => setError(err.message));
  }

  function editFix(fix) {
    setForm({ id: fix.id, garbled: fix.garbled, correct: fix.correct, enabled: fix.enabled !== 0 });
    setModalOpen(true);
  }

  const fixForm = (
    <form className="cat-edit" onSubmit={submit} style={{ flexWrap: 'wrap' }}>
      <input value={form.garbled} onChange={(e) => setForm({ ...form, garbled: e.target.value })} placeholder="乱码片段，如 倿仕广报摞廄岗" required />
      <input value={form.correct} onChange={(e) => setForm({ ...form, correct: e.target.value })} placeholder="正确文本，如 胡仕广报销到岗" />
      <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 启用
      </label>
      <button className="primary small" type="submit" disabled={!form.garbled.trim()}>{form.id ? '保存' : '添加修复'}</button>
      <button className="secondary small" type="button" onClick={() => { reset(); setModalOpen(false); }}>取消</button>
    </form>
  );

  function removeFix(fix) {
    setConfirm({
      title: `删除修复「${fix.garbled} → ${fix.correct}」？`,
      body: '删除后，导入招行 PDF 时这段乱码不再被替换。',
      confirmLabel: '删除',
      onConfirm: () => {
        setConfirm(null);
        api(`/api/cmb-text-fixes/${fix.id}`, { method: 'DELETE' })
          .then(load)
          .then(() => setNotice(`已删除修复「${fix.garbled} → ${fix.correct}」`))
          .catch((err) => setError(err.message));
      },
    });
  }

  function toggleEnabled(fix) {
    api(`/api/cmb-text-fixes/${fix.id}`, { method: 'PATCH', body: { enabled: fix.enabled === 0 } })
      .then(load)
      .catch((err) => setError(err.message));
  }

  return (
    <>
      <div className="page-head">
        <h1>招行乱码修复</h1>
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <p className="muted" style={{ marginBottom: 12 }}>{notice}</p>}
      <p className="muted">
        招商银行 PDF 导出时部分文字会被错误解码成乱码（例如名字、商户名）。这里配置「乱码片段 → 正确文本」，
        导入招行 PDF 时按你配置的顺序逐条替换。姓名等敏感信息只存在你自己的数据库里，不在源码中。
      </p>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="tree-head"><h2>已配置修复</h2></div>
        {fixes.length === 0 && <span className="muted">还没有修复项。</span>}
        <div className="cat-chips" style={{ marginTop: 10 }}>
          {fixes.map((fix) => (
            <span className="cat-chip rule-chip" key={fix.id}>
              <span className="chip-body">
                <code>{fix.garbled}</code>
                <span className="muted">→</span>
                <code>{fix.correct}</code>
              </span>
              <span className="chip-actions">
                <label className="switch" title="启用">
                  <input type="checkbox" checked={fix.enabled !== 0} onChange={() => toggleEnabled(fix)} />
                </label>
                <button type="button" className="chip-btn" title="编辑" onClick={() => editFix(fix)}>编辑</button>
                <button type="button" className="chip-btn danger" title="删除" onClick={() => removeFix(fix)}>✕</button>
              </span>
            </span>
          ))}
        </div>
      </div>
      {narrow && (
        <button className="primary" type="button" style={{ marginTop: 12, width: '100%' }} onClick={() => { reset(); setModalOpen(true); }}>新增修复</button>
      )}
      {!narrow && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="tree-head"><h2>{form.id ? '编辑修复' : '新增修复'}</h2></div>
          {fixForm}
        </div>
      )}
      {narrow && modalOpen && (
        <FormModal title={form.id ? '编辑修复' : '新增修复'} onClose={() => { setModalOpen(false); reset(); }}>
          {fixForm}
        </FormModal>
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          onClose={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}
    </>
  );
}

function ConfirmModal({ title, body, confirmLabel = '确定', danger = true, busy = false, onClose, onConfirm }) {
  useScrollLock(true);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal stack" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        {body && <p className="muted">{body}</p>}
        <div className="modal-actions">
          <button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className={danger ? 'danger' : 'primary'} type="button" disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DuplicatesPage() {
  const books = useBooks();
  const { bookQuery } = books;
  const [query, setQuery] = useState({ type: 'expense', window: 1, minScore: 80, minAmount: '', scope: 'all', sort: 'time' });
  const [form, setForm] = useState(query);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(30);
  const [picked, setPicked] = useState(() => new Set());
  // 批量删除时留组内哪一条：按组内列出的顺序（第 1 条、第 2 条……），
  // 不用「较早/较晚」——同一组时间往往一模一样，分不出早晚
  const [keepIndex, setKeepIndex] = useState(0);
  const [confirm, setConfirm] = useState(null);
  const seq = useRef(0);

  async function load() {
    const id = seq.current + 1;
    seq.current = id;
    setLoading(true);
    setError('');
    try {
      const { from, to } = scopeWindow(query.scope);
      const params = new URLSearchParams({
        type: query.type,
        window: String(query.window),
        minScore: String(query.minScore),
        sort: query.sort,
      });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (query.minAmount) params.set('minAmount', query.minAmount);
      if (bookQuery) params.set('bookId', String(books.currentBookId));
      const result = await api(`/api/duplicates?${params}`);
      if (seq.current !== id) return; // 已经切到别的条件了，丢弃这次结果
      setData(result);
      setLimit(30);
      setConfirm(null);
      // 处理过的组已经不在结果里了，顺手从选中集合里去掉
      const alive = new Set((result.groups || result.pairs).map((item) => item.key));
      setPicked((prev) => new Set([...prev].filter((key) => alive.has(key))));
    } catch (err) {
      if (seq.current === id) setError(err.message);
    } finally {
      if (seq.current === id) setLoading(false);
    }
  }
  useEffect(() => { load(); }, [query, bookQuery]);

  async function act(key, fn) {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusy('');
  }
  // 把「组」转成删除方案：留下 keepId，组内其余都删
  function planOf(group, keepId) {
    return { keepId, dropIds: group.ids.filter((id) => id !== keepId) };
  }
  function keepIn(group, tx) {
    const dropCount = group.count - 1;
    const index = group.items.findIndex((item) => item.id === tx.id);
    setConfirm({
      title: `删除同组另外 ${dropCount} 笔？`,
      body: `保留第 ${index + 1} 条：${formatWhen(tx.occurredAt)} · ${tx.accountName} · ${money(tx.amount)} 元，同组其余 ${dropCount} 笔一起删除。`,
      confirmLabel: '确定删除',
      onConfirm: () => act(group.key, () => api('/api/duplicates/resolve', {
        method: 'POST',
        body: { groups: [planOf(group, tx.id)] },
      })),
    });
  }
  const pairs = data?.pairs || [];
  const groups = data?.groups || [];
  const shown = groups.slice(0, limit);

  function toggle(key) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleAll(list) {
    setPicked((prev) => {
      const next = new Set(prev);
      const allOn = list.every((item) => next.has(item.key));
      list.forEach((item) => (allOn ? next.delete(item.key) : next.add(item.key)));
      return next;
    });
  }
  const pickedGroups = groups.filter((group) => picked.has(group.key));
  // 每组留下一条，其余都算要删的
  const pickedAmount = pickedGroups.reduce((sum, group) => sum + Number(group.amount) * (group.count - 1), 0);
  const pickedDropCount = pickedGroups.reduce((sum, group) => sum + group.count - 1, 0);
  // 组内最多几条，决定「保留第 N 条」能选到几
  const maxKeep = Math.max(2, ...groups.map((group) => group.items?.length || group.count || 0));
  // 组不足那么多条时，退到最后一条，不能不留
  const keepIdOf = (group) => group.items[Math.min(keepIndex, group.items.length - 1)].id;

  function bulkIgnore() {
    if (!pickedGroups.length) return;
    setConfirm({
      title: `标记 ${pickedGroups.length} 组为「不是重复」？`,
      body: '之后这些组不会再出现在查重列表里。',
      danger: false,
      confirmLabel: '确定忽略',
      onConfirm: () => act('bulk', () => api('/api/duplicates/ignore', { method: 'POST', body: { keys: pickedGroups.map((group) => group.key) } })),
    });
  }
  function bulkResolve() {
    if (!pickedGroups.length) return;
    setConfirm({
      title: `删除 ${pickedDropCount} 笔重复账单？`,
      body: `${pickedGroups.length} 组，每组保留第 ${keepIndex + 1} 条（按组内列出的顺序），共删 ${pickedDropCount} 笔、${money(pickedAmount)} 元。`,
      confirmLabel: '确定删除',
      onConfirm: () => act('bulk', () => api('/api/duplicates/resolve', {
        method: 'POST',
        body: {
          groups: pickedGroups.map((group) => planOf(group, keepIdOf(group))),
        },
      })),
    });
  }
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
          <h1>查重</h1>
        </div>
      </div>
      <p className="muted">
        微信、支付宝绑着银行卡时，同一次付款可能被记两次：钱包账单一条，银行卡扣款一条；
        要是同一份账单还导入过多次，可能记到三四条。
        这里把金额相同、时间接近、互相吻合的账单归成一组，按相似度打分 ——
        <b>一组里挑一条留下，其余一起删</b>，不用逐对判断。
        「相差 ≤N 天」指两笔账单之间允许的时间差；「全部 / 近一年…」才是账目发生的时间范围。
      </p>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      <section className="card stack">
        <div className="form-row wrap">
          <div className="segment" role="tablist">
            {[['expense', '支出'], ['income', '收入']].map(([value, label]) => (
              <button key={value} type="button" className={query.type === value ? 'active' : ''} onClick={() => setQuery({ ...query, type: value })}>{label}</button>
            ))}
          </div>
          <div className="segment" role="tablist">
            {DUP_WINDOWS.map(([value, label]) => (
              <button key={value} type="button" className={query.window === value ? 'active' : ''} onClick={() => setQuery({ ...query, window: value })}>{label}</button>
            ))}
          </div>
          <div className="segment" role="tablist">
            {DUP_SCOPES.map(([value, label]) => (
              <button key={value} type="button" className={query.scope === value ? 'active' : ''} onClick={() => setQuery({ ...query, scope: value })}>{label}</button>
            ))}
          </div>
          <div className="segment" role="tablist">
            {[['time', '按时间'], ['score', '按相似度']].map(([value, label]) => (
              <button key={value} type="button" className={query.sort === value ? 'active' : ''} onClick={() => setQuery({ ...query, sort: value })}>{label}</button>
            ))}
          </div>
          <div className="segment" role="tablist">
            {DUP_LEVELS.map(([value, label]) => (
              <button key={value} type="button" className={query.minScore === value ? 'active' : ''} onClick={() => setQuery({ ...query, minScore: value })}>{label}</button>
            ))}
          </div>
          <form className="row" onSubmit={(event) => { event.preventDefault(); setQuery({ ...query, minAmount: form.minAmount }); }}>
            <label className="row">最小金额<input style={{ width: 96 }} value={form.minAmount} onChange={(e) => setForm({ ...form, minAmount: e.target.value })} placeholder="0" /></label>
            <button className="secondary" type="submit" disabled={loading}>筛选</button>
          </form>
        </div>
      </section>
      {loading && <p className="muted">正在查找…</p>}
      <div className="grid stats">
        <div className="card stat"><div className="label">疑似重复</div><div className="value">{loading ? '…' : data ? `${groups.length} 组` : '—'}</div></div>
        <div className="card stat"><div className="label">可省下金额</div><div className="value expense">{loading ? '…' : data ? money(data.duplicateAmount) : '—'}</div></div>
        <div className="card stat"><div className="label">已忽略</div><div className="value">{loading ? '…' : data ? `${data.ignoredCount} 组` : '—'}</div></div>
      </div>
      {data?.ignoredCount > 0 && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="secondary" type="button" onClick={() => act('unignore', () => api('/api/duplicates/ignore', { method: 'DELETE' }))}>
            恢复已忽略的 {data.ignoredCount} 组
          </button>
        </div>
      )}
      {groups.length > 0 && (
        <div className="card dup-bulk">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="dup-pick">
              <input
                type="checkbox"
                checked={shown.every((group) => picked.has(group.key))}
                onChange={() => toggleAll(shown)}
                aria-label="全选当前显示"
              />
              全选当前 {shown.length} 组
            </label>
            <span className="tiny muted">已选 {pickedGroups.length} 组 · 将删 {pickedDropCount} 笔 · {money(pickedAmount)} 元</span>
            {groups.length > shown.length && (
              <button className="ghost small" type="button" onClick={() => toggleAll(groups)}>选中全部 {groups.length} 组</button>
            )}
            {pickedGroups.length > 0 && (
              <button className="ghost small" type="button" onClick={() => setPicked(new Set())}>清空选择</button>
            )}
            <span className="spacer" />
            <label className="row tiny">批量保留
              <AppSelect value={keepIndex} onChange={(e) => setKeepIndex(Number(e.target.value))}>
                {Array.from({ length: maxKeep }, (_, index) => (
                  <option key={index} value={index}>第 {index + 1} 条</option>
                ))}
              </AppSelect>
            </label>
            <button className="secondary small" type="button" disabled={!pickedGroups.length || busy === 'bulk'} onClick={bulkIgnore}>不是重复</button>
            <button className="danger small" type="button" disabled={!pickedGroups.length || busy === 'bulk'} onClick={bulkResolve}>
              {busy === 'bulk' ? '处理中…' : `删除重复的 ${pickedDropCount} 笔`}
            </button>
          </div>
        </div>
      )}
      <div className="list">
        {shown.map((group) => (
          <div className={`card dup-pair${picked.has(group.key) ? ' picked' : ''}`} key={group.key}>
            <div className="dup-head">
              <label className="dup-pick">
                <input type="checkbox" checked={picked.has(group.key)} onChange={() => toggle(group.key)} aria-label="选择这一组" />
              </label>
              <b>{money(group.amount)}</b>
              <span className="tag">{group.score >= 90 ? '很像' : '可能'}</span>
              <span className="tag accent">{group.count} 条重复</span>
              <span className="tiny muted">{group.reasons.join(' · ')}</span>
              <div className="row" style={{ marginLeft: 'auto' }}>
                <button className="ghost" type="button" disabled={busy === group.key} onClick={() => act(group.key, () => api('/api/duplicates/ignore', { method: 'POST', body: { key: group.key } }))}>不是重复</button>
              </div>
            </div>
            <div className="dup-sides">
              {group.items.map((tx, index) => (
                <div className="dup-side" key={tx.id}>
                  <div className="tiny muted">第 {index + 1} 条 · {formatWhen(tx.occurredAt)}</div>
                  <div className="dup-title">{tx.payee || tx.categoryName || '—'}</div>
                  <div className="tiny muted">
                    {[tx.accountName, tx.categoryName, tx.note].filter(Boolean).join(' · ')}
                  </div>
                  <button className="primary small" type="button" disabled={busy === group.key} onClick={() => keepIn(group, tx)}>
                    留这条，删其余 {group.count - 1} 笔
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {loading && !data && <div className="card"><p className="muted">正在查找…</p></div>}
        {data && groups.length === 0 && <div className="card"><p className="muted">没有找到疑似重复的账单，试试放宽条件。</p></div>}
        {groups.length > limit && (
          <div className="row">
            <span className="tiny muted">共 {groups.length} 组，已显示 {limit} 组</span>
            <button className="secondary" type="button" onClick={() => setLimit((n) => n + 30)}>显示更多</button>
            <button className="ghost" type="button" onClick={() => setLimit(groups.length)}>全部展开</button>
          </div>
        )}
      </div>
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger !== false}
          busy={!!busy}
          onClose={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}
    </>
  );
}

function UsersPage() {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  async function load() {
    const data = await api('/api/users');
    setUsers(data.users);
  }
  useEffect(() => { load().catch((err) => setError(err.message)); }, []);
  async function patch(id, body) {
    setError('');
    try {
      await api(`/api/users/${id}`, { method: 'PATCH', body });
      await load();
    } catch (err) { setError(err.message); }
  }
  return (
    <>
      <div className="page-head"><h1>用户</h1></div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        {users.map((user) => (
          <div className="item" key={user.id}>
            <div>
              <div>{user.displayName} <span className="tag">@{user.username}</span></div>
              <div className="tiny muted">{user.isAdmin ? '管理员' : '成员'} · {user.isActive ? '启用' : '停用'}</div>
            </div>
            <div className="row">
              <button className="secondary" type="button" onClick={() => patch(user.id, { isAdmin: !user.isAdmin })}>{user.isAdmin ? '取消管理员' : '设为管理员'}</button>
              <button className="secondary" type="button" onClick={() => patch(user.id, { isActive: !user.isActive })}>{user.isActive ? '停用' : '启用'}</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const BOOK_KIND_OPTIONS = [
  ['travel', '出游共享'],
  ['family', '家庭'],
  ['aa', 'AA'],
];

// 参与人 = 预设名单 + 账单里付过款/收过款的人。AA 平摊名单、付款人下拉都取这个合集，
// 免得「付过钱但没预设」或「只收过退款」的人被当成没参与
function bookPeopleNames(book) {
  if (!book) return [];
  const names = [];
  const push = (name) => {
    const value = String(name || '').trim();
    if (value && !names.includes(value)) names.push(value);
  };
  (book.participants || []).forEach((item) => push(typeof item === 'string' ? item : item.name));
  (book.billPeople || []).forEach((item) => push(typeof item === 'string' ? item : item.name));
  return names;
}

// 这个账本要不要算 AA：AA 类型天生算，出游/家庭看开关
function bookAaOn(book) {
  return !!book && (book.kind === 'aa' || !!book.aaEnabled);
}

// 分享链接要给别人打开。App 的页面在 https://localhost，不能拿这个当地址。
// 页面本身在本机时，用已配置的服务器地址（那边同时提供网页）；否则用当前网站地址。
function shareUrl(token) {
  const base = getApiBase().replace(/\/+$/, '');
  let origin = window.location.origin;
  try {
    const host = new URL(origin).hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (local && /^https?:\/\//i.test(base)) origin = base;
  } catch {
    /* 地址解析失败就用当前页面 */
  }
  return `${origin}/share/${token}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand('copy');
      input.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// 账本编辑弹窗：改名/改类型、管参与人和协作成员、开关分享、归档、删除
function BookEditModal({ book, onClose, onChanged }) {
  useScrollLock(true);
  const [name, setName] = useState(book.name);
  const [kind, setKind] = useState(book.kind);
  const [person, setPerson] = useState('');
  const [username, setUsername] = useState('');
  const [memberHits, setMemberHits] = useState([]);
  const [memberSearching, setMemberSearching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const personal = book.kind === 'personal';
  // 参与人 = 预设 + 账单里付过款/收过款的人，一起展示，来源标清楚
  const people = bookPeopleNames(book);
  const presetIds = new Map((book.participants || []).map((item) => [item.name, item.id]));
  const billPeople = new Map((book.billPeople || []).map((item) => [item.name, item]));
  const link = shareUrl(book.shareToken);
  // AA 开关：出游/家庭账本可以只记账不算账；AA 类型天生就是开的
  const [aaEnabled, setAaEnabled] = useState(!!book.aaEnabled);
  useEffect(() => { setAaEnabled(!!book.aaEnabled); }, [book.aaEnabled]);

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    function onBack(event) {
      event.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('capacitor:back', onBack);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('capacitor:back', onBack);
    };
  }, [onClose]);

  async function act(action) {
    setError('');
    setBusy(true);
    try {
      await action();
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function save(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    act(() => api(`/api/books/${book.id}`, { method: 'PATCH', body: { name: trimmed, kind } }));
  }

  // 开关 AA：开了才有参与人和平摊，关了就只记账
  function toggleAa(next) {
    setAaEnabled(next);
    act(() => api(`/api/books/${book.id}`, { method: 'PATCH', body: { aaEnabled: next } }));
  }

  function addPerson(event) {
    event.preventDefault();
    const value = person.trim();
    if (!value) return;
    act(async () => {
      await api(`/api/books/${book.id}/participants`, { method: 'POST', body: { name: value } });
      setPerson('');
    });
  }

  // 输关键字就去找人：用户名/昵称模糊匹配，已经在账本里的不再列出来
  useEffect(() => {
    const keyword = username.trim();
    if (!keyword) {
      setMemberHits([]);
      setMemberSearching(false);
      return undefined;
    }
    setMemberSearching(true);
    const timer = setTimeout(() => {
      api(`/api/users/search?q=${encodeURIComponent(keyword)}&excludeBookId=${book.id}`)
        .then((data) => setMemberHits(data.users || []))
        .catch(() => setMemberHits([]))
        .finally(() => setMemberSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [username, book.id]);

  function addMember(event) {
    event.preventDefault();
    // 回车/点按钮：直接用搜索结果里最靠前的那个，省得再点一次
    const hit = memberHits[0];
    if (!hit) {
      setError(username.trim() ? '没找到这个人，换个关键字试试' : '先输个用户名或昵称');
      return;
    }
    addMemberById(hit);
  }

  function addMemberById(user) {
    act(async () => {
      await api(`/api/books/${book.id}/members`, { method: 'POST', body: { userId: user.id } });
      setUsername('');
      setMemberHits([]);
    });
  }

  function copyLink() {
    copyText(link).then((ok) => {
      setCopied(ok);
      if (!ok) setError(link);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function destroy() {
    setConfirm({
      title: `删除「${book.name}」？`,
      body: '如果这个账本里已经有账单，只会归档（账单保留）；没账单才会真删。',
      confirmLabel: '删除',
      onConfirm: async () => {
        setConfirm(null);
        const result = await api(`/api/books/${book.id}`, { method: 'DELETE' });
        await onChanged();
        if (result.deleted) onClose();
      },
    });
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide stack modal-book" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-book-body">
        <h2>编辑账本</h2>
        {error && <div className="error">{error}</div>}
        <form className="form-row wrap" onSubmit={save}>
          <label>名称<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>类型
            <AppSelect value={kind} onChange={(e) => setKind(e.target.value)} disabled={personal}>
              {personal
                ? <option value="personal">个人</option>
                : BOOK_KIND_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </AppSelect>
          </label>
          <button className="primary" type="submit" disabled={busy}>保存</button>
        </form>
        {!personal && (
          <label className="book-aa-toggle">
            <input
              type="checkbox"
              checked={aaEnabled || kind === 'aa'}
              disabled={busy || kind === 'aa'}
              onChange={(e) => toggleAa(e.target.checked)}
            />
            <span>
              开启 AA 平摊
              <b className="muted">{kind === 'aa' ? '（AA 账本默认开启）' : '（关掉只记账，不算平摊）'}</b>
            </span>
          </label>
        )}
        {!personal && aaEnabled && (
          <div className="book-section">
            <span className="book-section-title">参与人（AA / 平摊的人）</span>
            <div className="book-members">
              {people.map((name) => {
                const id = presetIds.get(name);
                const bill = billPeople.get(name);
                const source = id !== undefined
                  ? '预设'
                  : [bill?.expense ? '付款' : '', bill?.income ? '收入' : ''].filter(Boolean).join('·');
                return (
                  <span className="cat-chip" key={name}>
                    <b>{name}</b>
                    {source && <span className="tiny muted">{source}</span>}
                    {id !== undefined && (
                      <button
                        type="button"
                        className="chip-btn danger"
                        title="移除预设（账单里的记录不会删）"
                        disabled={busy}
                        onClick={() => act(() => api(`/api/books/${book.id}/participants/${id}`, { method: 'DELETE' }))}
                      >✕</button>
                    )}
                  </span>
                );
              })}
              {people.length === 0 && <span className="tiny muted">还没设参与人</span>}
            </div>
            <form className="book-add-member" onSubmit={addPerson}>
              <input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="名字，比如 老王" />
              <button className="secondary small" type="submit" disabled={busy}>添加</button>
            </form>
            <p className="tiny muted">
              参与人 = 预设的人 + 账单里付过款/收过款的人，都会被算进 AA 平摊。预设了人，没垫钱的也会摊到他头上。
            </p>
          </div>
        )}
        {!personal && (
          <div className="book-section">
            <span className="book-section-title">协作成员（有登录账号）</span>
            <div className="book-members">
              {book.members.map((member) => (
                <span className="cat-chip" key={member.id}>
                  <b>{member.name}</b>
                  {member.role === 'owner' ? <span className="tiny muted">所有者</span> : (
                    <button
                      type="button"
                      className="chip-btn danger"
                      title="移除"
                      disabled={busy}
                      onClick={() => act(() => api(`/api/books/${book.id}/members/${member.id}`, { method: 'DELETE' }))}
                    >✕</button>
                  )}
                </span>
              ))}
            </div>
            <form className="book-add-member" onSubmit={addMember}>
              <div className="member-picker">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="用户名或昵称，输几个字就能搜"
                  autoComplete="off"
                />
                {username.trim() && (
                  <div className="member-suggest">
                    {memberSearching && <div className="member-suggest-empty tiny muted">搜索中…</div>}
                    {!memberSearching && memberHits.length === 0 && (
                      <div className="member-suggest-empty tiny muted">没匹配到用户</div>
                    )}
                    {!memberSearching && memberHits.map((user) => (
                      <button
                        type="button"
                        className="member-suggest-item"
                        key={user.id}
                        disabled={busy}
                        onClick={() => addMemberById(user)}
                      >
                        <b>{user.displayName}</b>
                        <span className="tiny muted">{user.username}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="secondary small" type="submit" disabled={busy || memberHits.length === 0}>加成员</button>
            </form>
            <p className="tiny muted">
              输关键字搜人（用户名、昵称都行），点结果直接加进来。协作成员登录后能看到这个账本、在里面记账，跟参与人是两回事。
            </p>
          </div>
        )}
        {!personal && (
          <div className="book-section">
            <span className="book-section-title">分享链接</span>
            <div className="book-actions">
              <button
                className="secondary small"
                type="button"
                disabled={busy}
                onClick={() => act(() => api(`/api/books/${book.id}/share`, {
                  method: 'POST',
                  body: { enabled: !book.shareEnabled, writable: !!book.shareWritable },
                }))}
              >
                {book.shareEnabled ? '关闭分享链接' : (book.shareWritable ? '开启可编辑分享' : '开启只读分享')}
              </button>
              {book.shareEnabled && (
                <button className="ghost small" type="button" onClick={copyLink}>{copied ? '已复制' : '复制链接'}</button>
              )}
              {book.shareEnabled && (
                <button
                  className="ghost small"
                  type="button"
                  disabled={busy}
                  onClick={() => act(() => api(`/api/books/${book.id}/share`, {
                    method: 'POST',
                    body: { enabled: true, writable: !book.shareWritable },
                  }))}
                >
                  {book.shareWritable ? '改为只读' : '改为可编辑'}
                </button>
              )}
            </div>
            {book.shareEnabled && (
              <p className="book-link">免登录链接（{book.shareWritable ? '可编辑' : '只读'}）：{link}</p>
            )}
          </div>
        )}
        </div>
        <div className="book-actions book-actions-foot">
          {!personal && (
            <button
              className="secondary small"
              type="button"
              disabled={busy}
              onClick={() => act(() => api(`/api/books/${book.id}`, { method: 'PATCH', body: { archived: !book.archived } }))}
            >
              {book.archived ? '取消归档' : '归档'}
            </button>
          )}
          <span className="spacer" />
          {!personal && (
            <button className="ghost danger-text small" type="button" onClick={destroy} disabled={busy}>删除</button>
          )}
          <button className="secondary" type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          onClose={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}
    </div>,
    document.body,
  );
}

function BooksPage() {
  const { books, currentBookId, setCurrentBookId, reload } = useBooks();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('travel');
  const [aa, setAa] = useState(true);
  const [people, setPeople] = useState('');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);

  async function run(action, ok) {
    setError('');
    setNotice('');
    try {
      const result = await action();
      await reload();
      if (ok) setNotice(ok(result));
    } catch (err) {
      setError(err.message);
    }
  }

  // 编辑弹窗里加完参与人/成员要立刻看到：reload 拿到最新账本列表，把 editing 换成新对象
  async function changed() {
    const list = await reload();
    setEditing((prev) => (prev ? (list.find((book) => book.id === prev.id) || prev) : null));
  }

  function create(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // AA 账本天生开着；出游/家庭看勾选。关掉就只记账，不记参与人
    const aaOn = kind === 'aa' || aa;
    // 参与人一次填多个：逗号、空格、顿号都认
    const names = aaOn ? people.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean) : [];
    run(async () => {
      const result = await api('/api/books', { method: 'POST', body: { name: trimmed, kind, aaEnabled: aaOn } });
      for (const person of names) {
        await api(`/api/books/${result.book.id}/participants`, { method: 'POST', body: { name: person } });
      }
      setName('');
      setPeople('');
      return `已创建「${result.book.name}」${names.length ? `，参与人 ${names.join('、')}` : ''}`;
    });
  }

  function toggleShare(book) {
    run(
      () => api(`/api/books/${book.id}/share`, { method: 'POST', body: { enabled: !book.shareEnabled } }),
      (result) => (result.book.shareEnabled
        ? `分享已开启（${result.book.shareWritable ? '可编辑' : '只读'}）：${shareUrl(result.book.shareToken)}`
        : '分享已关闭，旧链接失效'),
    );
  }

  function copyLink(book) {
    const link = shareUrl(book.shareToken);
    copyText(link).then((ok) => setNotice(ok ? `链接已复制：${link}` : link));
  }

  function toggleArchive(book) {
    run(
      () => api(`/api/books/${book.id}`, { method: 'PATCH', body: { archived: !book.archived } }),
      () => (book.archived ? `「${book.name}」已取消归档` : `「${book.name}」已归档`),
    );
  }

  function removeBook(book) {
    setConfirm({
      title: `删除「${book.name}」？`,
      body: book.kind === 'personal'
        ? '个人账本不能删除。'
        : '如果这个账本里已经有账单，只会归档（账单保留）；没账单才会真删。',
      confirmLabel: '删除',
      onConfirm: async () => {
        setConfirm(null);
        const result = await api(`/api/books/${book.id}`, { method: 'DELETE' });
        await reload();
        setNotice(result.archived ? `「${book.name}」还有账单，已归档` : `已删除「${book.name}」`);
      },
    });
  }

  const mine = books.filter((book) => book.role === 'owner' || book.role === 'member');
  const others = books.filter((book) => book.role !== 'owner' && book.role !== 'member');

  function BookRow({ book }) {
    const manage = book.role === 'owner' || book.role === 'admin';
    const personal = book.kind === 'personal';
    const link = shareUrl(book.shareToken);
    return (
      <tr className={book.id === currentBookId ? 'active' : ''}>
        <td>
          <div className="book-name-row">
            <b className="book-name">{book.name}</b>
            {book.id === currentBookId && <span className="tag current">当前</span>}
            {book.archived && <span className="tag">已归档</span>}
            {book.role !== 'owner' && <span className="tiny muted">所有者 {book.ownerName}</span>}
            {book.id !== currentBookId && (
              <button className="ghost tiny" type="button" onClick={() => setCurrentBookId(book.id)}>切换</button>
            )}
          </div>
        </td>
        <td><span className="tag">{book.kindLabel}</span></td>
        <td>
          <div className="book-people-line">
            <span className="tiny muted">协作</span>
            <span>{book.members.length ? book.members.map((member) => member.name).join('、') : '—'}</span>
          </div>
          {!personal && (
            <div className="book-people-line">
              <span className="tiny muted">参与</span>
              <span>{book.aaEnabled ? (bookPeopleNames(book).join('、') || '—') : '未开启 AA'}</span>
            </div>
          )}
        </td>
        <td>
          {book.shareEnabled ? (
            <button
              className="ghost danger-text tiny"
              type="button"
              title={link}
              onClick={() => copyLink(book)}
              style={{ whiteSpace: 'nowrap' }}
            >
              复制链接 · {book.shareWritable ? '可编辑' : '只读'}
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          <div className="book-actions-row">
            <button className="secondary tiny" type="button" onClick={() => setEditing(book)}>编辑</button>
            {manage && !personal && (
              <>
                <button className="secondary tiny" type="button" onClick={() => toggleShare(book)}>
                  {book.shareEnabled ? '关闭' : '开启'}
                </button>
                <button className="secondary tiny" type="button" onClick={() => toggleArchive(book)}>
                  {book.archived ? '取消归档' : '归档'}
                </button>
                <button className="ghost danger-text tiny" type="button" onClick={() => removeBook(book)}>删除</button>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <div className="page-head"><h1>账本</h1></div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <p className="muted" style={{ marginBottom: 12 }}>{notice}</p>}
      <div className="books-layout">
        <section className="card book-create">
          <form className="form-row wrap" onSubmit={create}>
            <label>账本名<input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如 泰国游、家里" required /></label>
            <label>类型
              <AppSelect value={kind} onChange={(e) => setKind(e.target.value)}>
                {BOOK_KIND_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </AppSelect>
            </label>
            <label className="book-aa-toggle">
              <input
                type="checkbox"
                checked={kind === 'aa' || aa}
                disabled={kind === 'aa'}
                onChange={(e) => setAa(e.target.checked)}
              />
              <span>开启 AA 平摊</span>
            </label>
            {(kind === 'aa' || aa) && (
              <label>参与人（可留空）
                <input value={people} onChange={(e) => setPeople(e.target.value)} placeholder="胡胡, 楠楠，逗号分隔" />
              </label>
            )}
            <button className="primary" type="submit">创建</button>
          </form>
          <p className="tiny muted" style={{ marginTop: 8 }}>
            协作成员 = 有登录账号的人；参与人 = AA/平摊名单，不用注册。不勾 AA 就只记账，不算谁该补给谁。
          </p>
        </section>
        <section className="card book-list-card">
          <h2>我的账本</h2>
          <table className="book-table">
            <thead>
              <tr><th>名称</th><th>类型</th><th>成员</th><th>分享链接</th><th>操作</th></tr>
            </thead>
            <tbody>
              {mine.map((book) => <BookRow key={book.id} book={book} />)}
            </tbody>
          </table>
          {mine.length === 0 && <p className="muted">还没有账本。</p>}
          {others.length > 0 && (
            <>
              <h2 style={{ marginTop: 18 }}>其他人的账本（管理员可见）</h2>
              <table className="book-table">
                <thead>
                  <tr><th>名称</th><th>类型</th><th>成员</th><th>分享链接</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {others.map((book) => <BookRow key={book.id} book={book} />)}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>
      {editing && (
        <BookEditModal book={editing} onClose={() => setEditing(null)} onChanged={changed} />
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          onClose={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}
    </>
  );
}

// 请客 / 自己承担的钱不进 AA，单独提示一句，免得以为漏算了
function aaSelfNote(aa) {
  const list = (aa?.members || []).filter((item) => Number(item.own) > 0);
  if (!list.length) return null;
  return `${list.map((item) => `${item.name} ${money(item.own)}`).join('、')} 是自己承担的（请客），没算进 AA。`;
}

function ShareAa({ aa }) {
  if (!aa || aa.memberCount < 2) return null;
  return (
    <div className="share-aa">
      <div className="card-head">
        <h2>AA 平摊</h2>
        <span className="tiny muted">总 {money(aa.total)} · {aa.memberCount} 人分摊</span>
      </div>
      <div className="table-scroll">
        <table className="aa-table">
          <thead>
            <tr><th>成员</th><th>已付</th><th>应摊</th><th>差额</th></tr>
          </thead>
          <tbody>
            {aa.members.map((item) => {
              const diff = Number(item.diff);
              return (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td>{money(item.paid)}</td>
                  <td>{money(item.share)}</td>
                  <td className={diff > 0 ? 'income' : diff < 0 ? 'expense' : 'muted'}>
                    {diff > 0 ? `应收 ${money(item.diff)}` : diff < 0 ? `应付 ${money(-diff)}` : '已平'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {aa.transfers.length > 0 && (
        <div className="aa-transfers">
          <h3>结算建议</h3>
          <ul>
            {aa.transfers.map((item) => (
              <li key={`${item.from}-${item.to}-${item.amount}`}>
                <b>{item.from}</b> 转给 <b>{item.to}</b> <span>{money(item.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {Number(aa.unassigned) !== 0 && (
        <p className="tiny muted">还有 {money(aa.unassigned)} 没填付款人，也一起算进平摊了。</p>
      )}
      {aaSelfNote(aa) && <p className="tiny muted">{aaSelfNote(aa)}</p>}
    </div>
  );
}

function entryCategory(item) {
  return item.categoryName || item.categoryLabel || '未分类';
}

function shareCategoryItems(entries, type) {
  const sums = new Map();
  for (const item of entries) {
    if (item.type !== type) continue;
    const name = entryCategory(item);
    sums.set(name, (sums.get(name) || 0) + Number(item.amount || 0));
  }
  return [...sums.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

function SharePage() {
  const rawToken = useParams().token || '';
  // 去除末尾标点/空格等常见复制污染，保留 base64url 字符
  const token = String(rawToken).replace(/[^A-Za-z0-9_-]/g, '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [catPick, setCatPick] = useState(null);
  const [filterKind, setFilterKind] = useState('expense');
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const listRef = useRef(null);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  const [form, setForm] = useState(() => ({
    memberName: '',
    type: 'expense',
    amount: '',
    categoryLabel: '',
    payee: '',
    note: '',
    occurredAt: nowLocal(),
    images: [],
  }));

  async function load() {
    if (!token) {
      setError('链接地址好像不完整，请检查是否复制完整。');
      return;
    }
    try {
      setData(await api(`/api/share/${token}`));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, [token]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api(`/api/share/${token}/entries`, {
        method: 'POST',
        body: {
          ...form,
          shareWith: data?.book?.aaEnabled ? sharePicked : undefined,
          images: imageList(form.images),
        },
      });
      setForm({ ...form, amount: '', categoryLabel: '', payee: '', note: '', images: [], shareWith: null });
      setNotice('记好了，谢谢！');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (error && !data) {
    return (
      <div className="auth">
        <div className="card auth-card stack">
          <h1>轻账单</h1>
          <div className="error">{error}</div>
          <p className="muted">链接可能已失效，找账本所有者要一下新的。</p>
        </div>
      </div>
    );
  }

  const entries = data?.entries || [];
  const expenseCats = shareCategoryItems(entries, 'expense');
  const incomeCats = shareCategoryItems(entries, 'income');
  const activeKind = catPick?.kind || filterKind;
  // 手机上支出/收入切换本身就是筛选；电脑上仍看全部，点饼图再收窄
  const pool = narrow ? entries.filter((item) => item.type === activeKind) : entries;
  const shown = catPick
    ? pool.filter((item) => item.type === catPick.kind && entryCategory(item) === catPick.name)
    : pool;
  const total = shown.reduce((sum, item) => (
    item.type === 'income' ? sum + Number(item.amount) : sum - Number(item.amount)
  ), 0);
  const pinAmount = shown.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  function pickShareCategory(kind, item) {
    const next = catPick?.kind === kind && catPick?.name === item.name ? null : { kind, name: item.name };
    setCatPick(next);
    if (next && window.matchMedia('(min-width: 901px)').matches) {
      listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  function pickFilterKind(kind) {
    setFilterKind(kind);
    if (catPick && catPick.kind !== kind) setCatPick(null);
  }
  const filterCats = activeKind === 'income' ? incomeCats : expenseCats;

  // 分摊人：账本预设名单 + 自己，默认全选；没坐车/请假的取消勾选
  const shareOptions = [...new Set([
    ...(data?.book?.participants || []),
    ...(form.memberName ? [String(form.memberName).trim()] : []),
  ])].filter(Boolean);
  const sharePicked = Array.isArray(form.shareWith) ? form.shareWith : shareOptions;
  function toggleShare(name, on) {
    setForm({
      ...form,
      shareWith: on ? [...new Set([...sharePicked, name])] : sharePicked.filter((item) => item !== name),
    });
  }
  return (
    <div className="auth">
      <div className="share-page">
        <div className="share-pin">
          <header className="share-header">
            <h1>{data ? data.book.name : '共享账本'}</h1>
            <p className="muted">
              {data
                ? `${data.book.kindLabel} · ${data.book.writable ? '可编辑，填个名字就能补账' : '只读，只能查看'}`
                : '正在打开…'}
            </p>
            {error && <div className="error">{error}</div>}
            {notice && <p className="muted">{notice}</p>}
          </header>
          <div className="share-filter">
            <div className="segment kind-switch" role="tablist" aria-label="收支">
              {[['expense', '支出'], ['income', '收入']].map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  data-kind={kind}
                  aria-selected={activeKind === kind}
                  className={activeKind === kind ? 'active' : ''}
                  onClick={() => pickFilterKind(kind)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="share-filter-row">
              <button
                type="button"
                className={`share-cat-chip${catPick?.kind === activeKind ? '' : ' on'}`}
                onClick={() => setCatPick(null)}
              >
                <span>全部</span>
                <b>{filterCats.length} 类</b>
              </button>
              {filterCats.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  className={`share-cat-chip${catPick?.kind === activeKind && catPick.name === item.name ? ' on' : ''}`}
                  onClick={() => pickShareCategory(activeKind, item)}
                >
                  <span>{item.name}</span>
                  <b>¥{money(item.amount)}</b>
                </button>
              ))}
              {filterCats.length === 0 && (
                <span className="tiny muted share-filter-empty">还没有{activeKind === 'income' ? '收入' : '支出'}</span>
              )}
            </div>
          </div>
          <div className="tree-head share-pin-count">
            <h2>已记 {shown.length} 笔</h2>
            <b>{pinAmount.toFixed(2)} 元</b>
          </div>
        </div>

        {data?.book?.writable && (
        <form className="card stack share-form" onSubmit={submit}>
          <div className="form-row wrap">
            <label>你的名字
              <input
                list="share-participant-options"
                value={form.memberName}
                onChange={(e) => setForm({ ...form, memberName: e.target.value })}
                placeholder="小王"
                required
              />
              <datalist id="share-participant-options">
                {(data?.book?.participants || []).map((name) => <option key={name} value={name} />)}
              </datalist>
            </label>
            <label>收支
              <AppSelect value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {[['expense', '我付的'], ['income', '我收的']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </AppSelect>
            </label>
            <label>金额<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
            <label>时间<input type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} /></label>
            <label>分类<input value={form.categoryLabel} onChange={(e) => setForm({ ...form, categoryLabel: e.target.value })} placeholder="门票 / 吃饭…" /></label>
            <label className="field-full">简述
              <input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} placeholder="露营双层巴士竹签以及其他" />
            </label>
            {data?.book?.aaEnabled && shareOptions.length > 0 && (
              <div className="field-full">
                <span className="tiny muted">谁一起分摊（没坐车 / 请假的取消勾选；一个都不勾 = 这笔我自己承担）</span>
                <div className="checks share-picks">
                  {shareOptions.map((name) => (
                    <label key={name}>
                      <input
                        type="checkbox"
                        checked={sharePicked.includes(name)}
                        onChange={(e) => toggleShare(name, e.target.checked)}
                      />
                      {name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <label>备注<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          <div>
            <span className="tiny muted">截图</span>
            <ImagePicker
              images={form.images}
              onChange={(images) => setForm({ ...form, images })}
              uploadPath={`/api/share/${token}/upload`}
            />
          </div>
          <button className="primary" type="submit" disabled={saving}>{saving ? '保存中…' : '补一笔'}</button>
        </form>
        )}

        <section className="card share-list" ref={listRef}>
          <div className="tree-head share-list-head">
            <h2>{catPick ? `${catPick.kind === 'income' ? '收入' : '支出'} · ${catPick.name}` : `已记 ${entries.length} 笔`}</h2>
            <b>{total.toFixed(2)} 元</b>
            {catPick && (
              <button className="ghost tiny" type="button" onClick={() => setCatPick(null)}>看全部</button>
            )}
          </div>
          <div className="list">
            {shown.map((item) => {
              // 标题跟账单列表一致：付款人 · 标题（标题 > 备注 > 分类兜底）
              const title = billTitle(item);
              const sub = [formatWhen(item.occurredAt), item.categoryName || item.categoryLabel, item.note]
                .filter(Boolean).filter((text) => text !== title).join(' · ');
              return (
                <div className="item" key={item.id}>
                  <div>
                    <div>{[item.memberName, title].filter(Boolean).join(' · ')}</div>
                    <div className="tiny muted">{sub}</div>
                    {item.images?.length > 0 && (
                      <div className="image-grid">
                        {item.images.map((url) => <BillImage key={url} url={url} />)}
                      </div>
                    )}
                  </div>
                  <b className={item.type === 'income' ? 'income' : 'expense'}>
                    {item.type === 'income' ? '+' : '-'}{money(item.amount)}
                  </b>
                </div>
              );
            })}
            {entries.length === 0 && <p className="muted">还没有人补账。</p>}
            {entries.length > 0 && shown.length === 0 && (
              <p className="muted">{catPick ? '这个分类下没有账单。' : `还没有${activeKind === 'income' ? '收入' : '支出'}。`}</p>
            )}
          </div>
        </section>

        <aside className="share-side">
          {data && (
            <>
              {data.book?.aaEnabled && data.aa?.memberCount >= 2 && (
                <section className="card share-aa-card">
                  <ShareAa aa={data.aa} />
                </section>
              )}
              <section className="card share-cat-card">
                <div className="card-head"><h2>支出分类</h2></div>
                <CategoryPie
                  items={expenseCats}
                  activeName={catPick?.kind === 'expense' ? catPick.name : ''}
                  onPick={(item) => pickShareCategory('expense', item)}
                  kind="expense"
                />
              </section>
              <section className="card share-cat-card">
                <div className="card-head"><h2>收入分类</h2></div>
                <CategoryPie
                  items={incomeCats}
                  activeName={catPick?.kind === 'income' ? catPick.name : ''}
                  onPick={(item) => pickShareCategory('income', item)}
                  kind="income"
                />
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export function App() {
  const { user, setUser, ready } = useSession();
  const [saved, setSaved] = useState(0);
  const bump = useCallback(() => setSaved((n) => n + 1), []);
  const navigate = useNavigate();
  if (!ready) return null;
  // 分享页免登录：也要放进 Routes，SharePage 才能从路由里拿到 :token
  if (!user) {
    return (
      <Routes>
        <Route path="/share/:token" element={<SharePage />} />
        <Route path="*" element={<AuthScreen onLogin={(next) => { setUser(next); navigate('/'); }} />} />
      </Routes>
    );
  }
  function logout() {
    setToken('');
    setUser(null);
  }
  return (
    <RefreshContext.Provider value={{ saved, bump }}>
      <BusyBar />
      <Shell user={user} onLogout={logout} onSaved={bump}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/bills" element={<Bills />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/duplicates" element={<DuplicatesPage />} />
          <Route path="/transfer-rules" element={<TransferRules />} />
          <Route path="/cmb-fixes" element={<CmbTextFixes />} />
          <Route path="/books" element={<BooksPage />} />
          <Route path="/me" element={<UserPage user={user} onLogout={logout} />} />
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/users" element={user.isAdmin ? <UsersPage /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </RefreshContext.Provider>
  );
}

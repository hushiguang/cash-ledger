import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, getToken, setToken } from './api.js';

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

function CreateBillModal({ open, onClose, onSaved }) {
  const books = useBooks();
  const [form, setForm] = useState(emptyBill);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const shared = !!books.currentBook && books.currentBook.kind !== 'personal';
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal modal-wide stack" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2>记一笔{books.currentBook ? ` · ${books.currentBook.name}` : ''}</h2>
        {error && <div className="error">{error}</div>}
        {shared ? (
          <SharedBillFields form={form} setForm={setForm} accounts={books.accounts} categories={books.categories} />
        ) : (
          <BookFields form={form} setForm={setForm} accounts={books.accounts} categories={books.categories} />
        )}
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>取消</button>
          <button className="primary" type="submit" disabled={saving}>{saving ? '保存中…' : '记一笔'}</button>
        </div>
      </form>
    </div>
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
    { title: '整理', items: [['/import', '导入', 'download'], ['/accounts', '账户', 'wallet'], ['/categories', '分类', 'tag'], ['/duplicates', '查重', 'copy']] },
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
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
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
      {open && (
        <>
          <div className="book-backdrop" onClick={() => setOpen(false)} />
          <div className="book-menu">
            <div className="book-menu-head">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索账本…" autoFocus />
            </div>
            <div className="book-menu-list">
              {filtered.map((book) => (
                <button
                  key={book.id}
                  type="button"
                  className={book.id === currentBookId ? 'active' : ''}
                  onClick={() => { onChange(book.id); setOpen(false); }}
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
                  {book.id === currentBookId && <span className="book-check">✓</span>}
                </button>
              ))}
              {!filtered.length && <p className="muted" style={{ padding: '10px 8px' }}>没有匹配的账本</p>}
            </div>
            <NavLink className="book-manage" to="/books" onClick={() => setOpen(false)}>管理账本…</NavLink>
          </div>
        </>
      )}
    </div>
  );
}

function Shell({ user, onLogout, onSaved, children }) {
  const [creating, setCreating] = useState(false);
  const books = useBooksSource();
  const { books: bookList, currentBookId, setCurrentBookId } = books;
  const groups = navGroups(user.isAdmin);
  return (
    <BooksContext.Provider value={books}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">轻账单<span className="brand-sub">LEDGER</span></div>
          <BookSwitch books={bookList} currentBookId={currentBookId} onChange={setCurrentBookId} />
          <button className="primary new-bill" type="button" onClick={() => setCreating(true)}>＋ 记一笔</button>
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
        <main className="main">{children}</main>
        <button className="fab" type="button" title="记一笔" aria-label="记一笔" onClick={() => setCreating(true)}>+</button>
        <CreateBillModal open={creating} onClose={() => setCreating(false)} onSaved={onSaved} />
      </div>
    </BooksContext.Provider>
  );
}

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [config, setConfig] = useState({ allowRegister: true, hasUsers: true });
  const [form, setForm] = useState({ username: '', password: '', displayName: '' });
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/auth/config').then(setConfig).catch(() => {});
  }, []);
  async function submit(event) {
    event.preventDefault();
    setError('');
    try {
      const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const data = await api(path, { method: 'POST', body: form });
      setToken(data.token);
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
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
        <button className="primary" type="submit">{mode === 'register' ? '注册' : '登录'}</button>
        {config.allowRegister && (
          <button className="secondary" type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? '没有账号，去注册' : '已有账号，去登录'}
          </button>
        )}
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

function BookFields({ form, setForm, accounts, categories, showTime = true }) {
  const cats = categories.filter((c) => !c.archived && c.kind === form.type);
  return (
    <div className="form-row wrap">
      <label>类型
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, categoryId: '' })}>
          {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>金额<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
      {showTime && <label>时间<input type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} required /></label>}
      <label>{form.type === 'transfer' ? '转出账户' : '账户'}
        <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })} required>
          <option value="">请选择</option>
          {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      {form.type === 'transfer' ? (
        <label>转入账户
          <select value={form.toAccountId} onChange={(e) => setForm({ ...form, toAccountId: e.target.value })} required>
            <option value="">请选择</option>
            {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      ) : (
        <label>分类
          <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
            <option value="">未分类</option>
            {cats.filter((c) => !c.parentId).map((parent) => (
              <optgroup key={parent.id} label={parent.name}>
                <option value={parent.id}>{parent.name}</option>
                {cats.filter((c) => c.parentId === parent.id).map((child) => (
                  <option key={child.id} value={child.id}>{child.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      <label className="field-full">对方<input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} /></label>
      <label className="field-full">备注<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
    </div>
  );
}

// 图片：选文件直接传图床，缩略图走服务端代理（图床是自签证书，浏览器直连会加载失败）
function imageSrc(url) {
  return `/api/image?u=${encodeURIComponent(url || '')}`;
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
              <img src={imageSrc(url)} alt="" onClick={() => window.open(imageSrc(url), '_blank')} />
              <button type="button" className="chip-btn danger" title="移除" onClick={() => onChange(list.filter((item) => item !== url))}>✕</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// 共享/家庭账本用的简化表单：账户可留空，分类自己填（已有的会联想出来），必填付款人/收款人
function SharedBillFields({ form, setForm, accounts, categories, showTime = true }) {
  const names = [...new Set(categories.filter((c) => !c.archived && c.kind === form.type).map((c) => c.name))];
  return (
    <div className="form-row wrap">
      <label>收支
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {[['expense', '支出'], ['income', '收入']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>金额<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
      {showTime && <label>时间<input type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} /></label>}
      <label>{form.type === 'income' ? '收款人' : '付款人'}
        <input value={form.memberName} onChange={(e) => setForm({ ...form, memberName: e.target.value })} placeholder="谁付的 / 谁收的" required />
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
        <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
          <option value="">不填</option>
          {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
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

async function fetchExport(format, query = '') {
  const params = new URLSearchParams(String(query).replace(/^\?/, ''));
  params.set('format', format);
  const response = await fetch(`/api/export?${params}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
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
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
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
  return (
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
    </div>
  );
}

function BillDetail({ tx, onClose, onDelete, onSave }) {
  const books = useBooks();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const flag = billFlag(tx);
  const rows = [
    ['类型', [typeLabel(tx.type), flag?.label].filter(Boolean).join(' · ')],
    ['时间', formatWhen(tx.occurredAt)],
    ['账户', accountLine(tx)],
    ['分类', tx.categoryName || tx.categoryLabel],
    [tx.type === 'income' ? '收款人' : '付款人', tx.memberName],
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal ${editing ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bill-title"
        onClick={(event) => event.stopPropagation()}
      >
        {editing ? (
          <form className="stack" onSubmit={save}>
            <h2 id="bill-title">编辑账单</h2>
            {books.books.find((book) => book.id === tx.bookId)?.kind !== 'personal' && tx.bookId ? (
              <SharedBillFields form={form} setForm={setForm} accounts={books.accounts} categories={books.categories} />
            ) : (
              <BookFields form={form} setForm={setForm} accounts={books.accounts} categories={books.categories} />
            )}
            {error && <div className="error">{error}</div>}
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
                {tx.images.map((url) => (
                  <a key={url} href={imageSrc(url)} target="_blank" rel="noreferrer">
                    <img src={imageSrc(url)} alt="" />
                  </a>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button className="secondary" type="button" onClick={onClose}>关闭</button>
              <button className="danger" type="button" onClick={() => onDelete(tx.id)}>删除</button>
              <button className="primary" type="button" onClick={startEdit}>编辑</button>
            </div>
          </>
        )}
      </div>
    </div>
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

function parseLocalDate(text) {
  const s = String(text || '').slice(0, 10);
  return new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
}

// 总览页所有数据共用一个时间区间：以光标所在月为末尾，往前推相应月数
function rangeWindow(cursor, range, firstDate, custom) {
  if (range === 'custom' && custom?.from && custom?.to) {
    return { from: custom.from, to: custom.to, label: `${custom.from} ~ ${custom.to}` };
  }
  const to = localDate(new Date(cursor.year, cursor.month, 0));
  let start;
  if (range === 'all') {
    const base = firstDate ? parseLocalDate(firstDate) : new Date(cursor.year, cursor.month - 1, 1);
    start = new Date(base.getFullYear(), base.getMonth(), 1);
  } else {
    start = new Date(cursor.year, cursor.month - (RANGE_MONTHS[range] || 1), 1);
  }
  const from = localDate(start);
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

const PIE_COLORS = ['#ff4d6a', '#7c5cff', '#2ec4b6', '#ffb703', '#4ea8de', '#f072b6', '#00b894', '#ff8c42'];

function CategoryPie({ items, activeName, onPick }) {
  const total = items.reduce((sum, item) => sum + Number(item.amount), 0);
  if (!items.length || total <= 0) return <p className="muted">这个月还没有支出。</p>;
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
        <text x={cx} y={cy + 18} className="pie-label" textAnchor="middle">支出合计</text>
      </svg>
      <ul className="pie-legend">
        {slices.map((slice) => (
          <li key={slice.item.name}>
            <button type="button" className={activeName === slice.item.name ? 'active' : ''} onClick={() => onPick(slice.item)}>
              <i style={{ background: slice.color }} />
              <span>{slice.item.name}</span>
              <b>{money(slice.item.amount)}</b>
              <em>{Math.round(slice.share * 100)}%</em>
            </button>
          </li>
        ))}
      </ul>
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
  const [trendMode, setTrendMode] = useState('line');
  const [piePick, setPiePick] = useState(null);
  const [pieBills, setPieBills] = useState([]);
  const [pieOpen, setPieOpen] = useState(null);
  const [openTx, setOpenTx] = useState(null);
  const monthStart = useMemo(() => localDate(new Date(now.getFullYear(), now.getMonth(), 1)), []);
  const monthEnd = useMemo(() => localDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)), []);
  const [custom, setCustom] = useState({ from: monthStart, to: monthEnd });
  const win = useMemo(() => rangeWindow(cursor, range, summary?.firstDate, custom), [cursor, range, summary?.firstDate, custom]);
  useEffect(() => {
    api(`/api/summary?from=${win.from}&to=${win.to}&${bookQuery}`).then(setSummary);
    api(`/api/transactions?from=${win.from}&to=${win.to}&${bookQuery}`).then((data) => setRecent(data.transactions.slice(0, 8)));
  }, [win.from, win.to, saved, bookQuery]);
  useEffect(() => {
    api(`/api/trend?from=${win.from}&to=${win.to}&${bookQuery}`).then(setTrend).catch(() => setTrend(null));
  }, [win.from, win.to, saved, bookQuery]);
  function shift(delta) {
    const d = new Date(cursor.year, cursor.month - 1 + delta, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 });
    setPiePick(null);
  }
  // ids 为空表示「未分类」，后端用 none 匹配没有分类的账单
  const pieQuery = (ids) => `/api/transactions?from=${win.from}&to=${win.to}&type=expense&categoryIds=${ids?.length ? ids.join(',') : 'none'}`;
  function pickCategory(item) {
    if (piePick?.name === item.name) {
      setPiePick(null);
      return;
    }
    setPiePick(item);
    api(pieQuery(item.ids)).then((data) => setPieBills(data.transactions));
  }
  async function removePieBill(id) {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    setPieOpen(null);
    const data = await api(pieQuery(piePick.ids));
    setPieBills(data.transactions);
    bump();
  }
  const max = Math.max(...(summary?.categories.map((c) => Number(c.amount)) || [1]), 1);
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
          <h1>{win.label}</h1>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="segment" role="tablist">
            {TREND_RANGES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={range === value ? 'active' : ''}
                onClick={() => { setRange(value); setPiePick(null); }}
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
            <>
              <button className="secondary" type="button" onClick={() => shift(-1)}>{range === 'month' ? '上个月' : '前一月'}</button>
              <button className="secondary" type="button" onClick={() => shift(1)}>{range === 'month' ? '下个月' : '后一月'}</button>
            </>
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
      <section className="card trend-card">
        <div className="card-head">
          <h2>{trendMode === 'line' ? '收支走势' : '支出分类占比'}</h2>
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
            <CategoryPie items={summary?.categories || []} activeName={piePick?.name} onPick={pickCategory} />
            {piePick && (
              <div className="pie-bills">
                <div className="tree-head">
                  <h2>{piePick.name} · {pieBills.length} 笔</h2>
                  <button className="secondary small" type="button" onClick={() => setPiePick(null)}>收起</button>
                </div>
                <div className="ledger">
                  {pieBills.map((tx) => {
                    const flag = billFlag(tx);
                    return (
                      <button className="tx-row" type="button" key={tx.id} onClick={() => setPieOpen(tx)}>
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
                  {pieBills.length === 0 && <p className="muted">这个分类下没有账单。</p>}
                </div>
              </div>
            )}
          </>
        )}
      </section>
      {pieOpen && (
        <BillDetail
          tx={pieOpen}
          onClose={() => setPieOpen(null)}
          onDelete={removePieBill}
          onSave={async () => {
            setPieOpen(null);
            const data = await api(pieQuery(piePick?.ids));
            setPieBills(data.transactions);
            setSaved((n) => n + 1);
          }}
        />
      )}
      <div className="grid cards" style={{ marginTop: 12 }}>
        <section className="card">
          <h2>支出分类</h2>
          <div className="list">
            {(summary?.categories || []).map((item) => (
              <div key={item.name}>
                <div className="item"><span>{item.name}</span><b>{money(item.amount)}</b></div>
                <div className="bar"><span style={{ width: `${(Number(item.amount) / max) * 100}%` }} /></div>
              </div>
            ))}
            {summary && summary.categories.length === 0 && <p className="muted">这段时间还没有支出。</p>}
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
  const { bookQuery } = books;
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [days, setDays] = useState([]);
  const [picked, setPicked] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    api(`/api/calendar?year=${cursor.year}&month=${cursor.month}&${bookQuery}`).then((data) => setDays(data.days));
  }, [cursor, bookQuery]);
  useEffect(() => {
    if (!picked) return;
    api(`/api/transactions?from=${picked}&to=${picked}&${bookQuery}`).then((data) => setItems(data.transactions));
  }, [picked, bookQuery]);
  const map = useMemo(() => Object.fromEntries(days.map((d) => [d.day, d])), [days]);
  const first = new Date(cursor.year, cursor.month - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const count = new Date(cursor.year, cursor.month, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
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
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
          <h1>日历</h1>
        </div>
        <div className="row">
          <button className="secondary" type="button" onClick={() => shift(-1)}>上个月</button>
          <strong>{cursor.year} 年 {cursor.month} 月</strong>
          <button className="secondary" type="button" onClick={() => shift(1)}>下个月</button>
        </div>
      </div>
      <div className="calendar">
        {WEEKDAYS.map((name) => <div className="dow" key={name}>{name}</div>)}
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
              {info && Number(info.expense) > 0 && <div className="tiny expense">-{money(info.expense)}</div>}
              {info && Number(info.income) > 0 && <div className="tiny income">+{money(info.income)}</div>}
              {info?.planned?.length > 0 && <div className="tiny muted">待入账 {info.planned.length}</div>}
            </div>
          );
        })}
      </div>
      {picked && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="tree-head">
            <h2>{picked}</h2>
            <div className="row">
              {sumOf('expense') > 0 && <span className="tiny expense">支出 {money(sumOf('expense'))}</span>}
              {sumOf('income') > 0 && <span className="tiny income">收入 {money(sumOf('income'))}</span>}
              <button className="secondary small" type="button" onClick={() => setPicked('')}>收起</button>
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
  const activeBookId = books.currentBookId;
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [exporting, setExporting] = useState('');
  const [clearing, setClearing] = useState(false);
  const bookId = activeBookId || '';
  function queryString() {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (type) params.set('type', type);
    if (source) params.set('source', source);
    if (bookId) params.set('bookId', bookId);
    const text = params.toString();
    return text ? `?${text}` : '';
  }
  async function load() {
    const data = await api(`/api/transactions${queryString()}`);
    setRows(data.transactions);
    setTotal(data.total ?? data.transactions.length);
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
  useEffect(() => { load().catch((err) => setError(err.message)); }, [bookId]);
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
  const groups = groupByDay(rows);
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
          <h1>账单</h1>
        </div>
        <div className="row">
          <button className="secondary" type="button" disabled={!!exporting} onClick={() => download('csv')}>{exporting === 'csv' ? '导出中' : '导出 CSV'}</button>
          <button className="secondary" type="button" disabled={!!exporting} onClick={() => download('xlsx')}>{exporting === 'xlsx' ? '导出中' : '导出 Excel'}</button>
          <button className="danger" type="button" disabled={!!exporting} onClick={() => setClearing(true)}>清除账单</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <form className="card row search-row" onSubmit={(e) => { e.preventDefault(); load().catch((err) => setError(err.message)); }}>
        <label>类型
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">全部</option>
            {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>来源
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(SOURCES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>开始<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>结束<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="grow">关键词
          <input placeholder="对方、备注、分类、账户、金额" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="primary" type="submit">查询</button>
      </form>
      <p className="query-count muted">
        {total > rows.length ? `共 ${total} 笔，显示最近 ${rows.length} 笔` : `共 ${total} 笔`}
      </p>
      <div className="card ledger">
        {groups.map((group) => (
          <section key={group.day}>
            <div className="tx-day">
              <span>{formatDay(group.day)}</span>
              <span>{group.items.length} 笔</span>
            </div>
            {group.items.map((tx) => {
              const flag = billFlag(tx);
              return (
              <div className="tx-line" key={tx.id}>
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

function Recurring() {
  const books = useBooks();
  const { bookQuery } = books;
  const shared = !!books.currentBook && books.currentBook.kind !== 'personal';
  const [rules, setRules] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    ...emptyBill(),
    frequency: 'monthly',
    intervalDays: 1,
    weekdays: [1],
    startDate: nowLocal().slice(0, 10),
    endDate: '',
    time: '09:00',
  });
  async function load() {
    const data = await api(`/api/recurring?${bookQuery}`);
    setRules(data.rules);
  }
  useEffect(() => { load().catch((err) => setError(err.message)); }, [bookQuery]);
  async function submit(event) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/recurring', {
        method: 'POST',
        body: {
          ...form,
          bookId: books.currentBookId || null,
          accountId: form.accountId ? Number(form.accountId) : null,
          toAccountId: form.toAccountId ? Number(form.toAccountId) : null,
          categoryId: form.categoryId ? Number(form.categoryId) : null,
          monthDay: Number(form.startDate.slice(8, 10)),
          yearMonth: Number(form.startDate.slice(5, 7)),
          yearDay: Number(form.startDate.slice(8, 10)),
        },
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  function toggleDay(day) {
    const set = new Set(form.weekdays);
    if (set.has(day)) set.delete(day);
    else set.add(day);
    setForm({ ...form, weekdays: [...set].sort() });
  }
  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{books.currentBook ? books.currentBook.name : '全部账本'}</span>
          <h1>定期</h1>
        </div>
      </div>
      <form className="card stack" onSubmit={submit}>
        {error && <div className="error">{error}</div>}
        <BookFields
          form={form}
          setForm={setForm}
          accounts={shared ? [{ id: '', name: '不填账户（共享账本）' }, ...books.accounts] : books.accounts}
          categories={books.categories}
          showTime={false}
        />
        <div className="form-row">
          <label>周期
            <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              {FREQS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {form.frequency === 'interval' && (
            <label>间隔天数<input type="number" min="1" value={form.intervalDays} onChange={(e) => setForm({ ...form, intervalDays: Number(e.target.value) })} /></label>
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
        <button className="primary" type="submit">保存定期账单</button>
      </form>
      <div className="card" style={{ marginTop: 12 }}>
        {rules.map((rule) => (
          <div className="item" key={rule.id}>
            <div>
              <div>{rule.payee || rule.note || FREQS.find((f) => f[0] === rule.frequency)?.[1]} · {money(rule.amount)}</div>
              <div className="tiny muted">{rule.paused ? '已暂停' : `下次 ${rule.nextRun || '已结束'}`} · {rule.startDate}</div>
            </div>
            <div className="row">
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
  ['externalId', '单号'],
];

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
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);
  return (
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
    </div>
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
  const rows = parsed.flatMap((file) => file.rows || []);
  const readyCount = rows.filter((row, index) => picked[index] && !row.skipReason).length;
  const pageSize = 80;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageStart = Math.min(page, pageCount - 1) * pageSize;
  const visibleRows = rows.slice(pageStart, pageStart + pageSize);
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
    const merged = replacePending ? nextParsed : [...parsed, ...nextParsed];
    const queued = replacePending ? nextPending : [...pending.slice(1), ...nextPending];
    setParsed(merged);
    setPending(queued);
    setMapping(queued[0]?.suggested || {});
    const flat = merged.flatMap((file) => file.rows || []);
    setPicked(Object.fromEntries(flat.map((row, index) => [index, !row.skipReason])));
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
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="auto">自动识别</option>
            <option value="wechat">微信</option>
            <option value="alipay">支付宝</option>
            <option value="jd">京东</option>
            <option value="qianji">钱迹</option>
            <option value="cmb">招商银行</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <label>文件
          <input type="file" accept=".csv,.xlsx,.xls,.txt,.pdf" multiple onChange={(e) => setFiles([...(e.target.files || [])])} required={!files.length} />
        </label>
        {files.length > 0 && <p className="muted">已选 {files.length} 个文件：{files.map((file) => file.name).join('、')}</p>}
        {parsing && <p className="loading">正在解析账单…</p>}
        <button className="primary" type="submit" disabled={!files.length || parsing}>{parsing ? '解析中…' : '解析账单'}</button>
      </form>
      {mappingFile && (
        <form className="card stack" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); parseUploads([mappingFile.file], mapping, false).catch((err) => setError(err.message)); }}>
          <h2>映射 {mappingFile.filename}</h2>
          <p className="muted">还有 {pending.length} 个文件需要指定字段。{pending.length > 1 ? '映射完这个会继续下一个。' : ''}</p>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            {MAP_FIELDS.map(([field, label]) => (
              <label key={field}>{label}
                <select value={mapping[field] || ''} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}>
                  <option value="">不映射</option>
                  {mappingFile.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                </select>
              </label>
            ))}
          </div>
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
          <div className="preview">
            <table>
              <thead><tr><th></th><th>文件</th><th>时间</th><th>类型</th><th>金额</th><th>对方</th><th>账户</th><th>说明</th></tr></thead>
              <tbody>
                {visibleRows.map((row, index) => {
                  const rowIndex = pageStart + index;
                  return (
                    <tr key={`${row.filename}-${rowIndex}`}>
                      <td><input type="checkbox" disabled={!!row.skipReason} checked={!!picked[rowIndex]} onChange={(e) => setPicked({ ...picked, [rowIndex]: e.target.checked })} /></td>
                      <td className="clip">{row.filename}</td>
                      <td>{row.occurredAt}</td>
                      <td>{TYPES.find((item) => item[0] === row.type)?.[1] || ''}</td>
                      <td>{row.amount}</td>
                      <td>{row.payee}</td>
                      <td>{row.accountName}</td>
                      <td className="muted clip wide">{row.skipReason || row.note || row.categoryName}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > pageSize && (
            <div className="row pager">
              <button className="secondary" type="button" disabled={pageStart === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button>
              <span className="muted">{pageStart + 1}–{Math.min(pageStart + pageSize, rows.length)} / {rows.length}</span>
              <button className="secondary" type="button" disabled={pageStart + pageSize >= rows.length} onClick={() => setPage((current) => current + 1)}>下一页</button>
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
                <select value={account.kind} onChange={(e) => setAccount({ ...account, kind: e.target.value })}>
                  {ACCOUNT_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
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
              <select value={merge.sourceId} onChange={(e) => setMerge({ ...merge, sourceId: e.target.value })} required>
                <option value="">请选择</option>
                {accounts.filter((a) => !a.archived || a.mergedInto).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label>归到哪个账户
              <select value={merge.targetId} onChange={(e) => setMerge({ ...merge, targetId: e.target.value })} required>
                <option value="">请选择</option>
                {primary.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
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
                <select value={alias.accountId} onChange={(e) => setAlias({ ...alias, accountId: e.target.value })} required>
                  <option value="">请选择</option>
                  {primary.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
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
      {mergeModal && (
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
        </div>
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
        <button className="secondary" type="button" onClick={() => { setAdding({ parentId: null }); setName(''); }}>新增一级分类</button>
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <p className="muted" style={{ marginBottom: 12 }}>{notice}</p>}
      <div className="split">
        <nav className="side-tabs">
          {[['expense', '支出'], ['income', '收入']].map(([value, label]) => (
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
        </section>
      </div>
      {confirm && (
        <ConfirmModal
          title={`确定${confirm.label}「${confirm.item.name}」？`}
          body={confirm.body}
          confirmLabel={`确定${confirm.label}`}
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

function ConfirmModal({ title, body, confirmLabel = '确定', danger = true, busy = false, onClose, onConfirm }) {
  return (
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
    </div>
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
  const [keepRule, setKeepRule] = useState('earlier');
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
      // 处理过的配对已经不在结果里了，顺手从选中集合里去掉
      const alive = new Set(result.pairs.map((pair) => pair.key));
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
  function keep(pair, pick) {
    const drop = pick === 'a' ? pair.b : pair.a;
    const keepSide = pick === 'a' ? pair.a : pair.b;
    setConfirm({
      title: '删除另一条？',
      body: `保留 ${formatWhen(keepSide.occurredAt)} · ${keepSide.accountName} · ${money(keepSide.amount)} 元，删除 ${formatWhen(drop.occurredAt)} · ${drop.accountName} · ${money(drop.amount)} 元。`,
      confirmLabel: '确定删除',
      onConfirm: () => act(pair.key, () => api(`/api/transactions/${drop.id}`, { method: 'DELETE' })),
    });
  }
  const pairs = data?.pairs || [];
  const shown = pairs.slice(0, limit);

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
      const allOn = list.every((pair) => next.has(pair.key));
      list.forEach((pair) => (allOn ? next.delete(pair.key) : next.add(pair.key)));
      return next;
    });
  }
  const pickedPairs = pairs.filter((pair) => picked.has(pair.key));
  const pickedAmount = pickedPairs.reduce((sum, pair) => sum + Number(pair.amount), 0);

  function bulkIgnore() {
    if (!pickedPairs.length) return;
    setConfirm({
      title: `标记 ${pickedPairs.length} 对为「不是重复」？`,
      body: '之后这些配对不会再出现在查重列表里。',
      danger: false,
      confirmLabel: '确定忽略',
      onConfirm: () => act('bulk', () => api('/api/duplicates/ignore', { method: 'POST', body: { keys: pickedPairs.map((pair) => pair.key) } })),
    });
  }
  function bulkResolve() {
    if (!pickedPairs.length) return;
    const rule = keepRule === 'later' ? '保留时间较晚的一条' : '保留时间较早的一条';
    setConfirm({
      title: `删除 ${pickedPairs.length} 笔重复账单？`,
      body: `每组${rule}，共删 ${pickedPairs.length} 笔、${money(pickedAmount)} 元。`,
      confirmLabel: '确定删除',
      onConfirm: () => act('bulk', () => api('/api/duplicates/resolve', { method: 'POST', body: { keys: pickedPairs.map((pair) => pair.key), keep: keepRule } })),
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
        微信、支付宝绑着银行卡时，同一次付款可能被记两次：钱包账单一条，银行卡扣款一条。
        这里把金额相同、时间接近、分属不同账户的账单配成对，按相似度打分，你逐对确认。
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
        <div className="card stat"><div className="label">疑似重复</div><div className="value">{loading ? '…' : data ? `${pairs.length} 对` : '—'}</div></div>
        <div className="card stat"><div className="label">涉及金额</div><div className="value expense">{loading ? '…' : data ? money(data.duplicateAmount) : '—'}</div></div>
        <div className="card stat"><div className="label">已忽略</div><div className="value">{loading ? '…' : data ? `${data.ignoredCount} 对` : '—'}</div></div>
      </div>
      {data?.ignoredCount > 0 && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="secondary" type="button" onClick={() => act('unignore', () => api('/api/duplicates/ignore', { method: 'DELETE' }))}>
            恢复已忽略的 {data.ignoredCount} 对
          </button>
        </div>
      )}
      {pairs.length > 0 && (
        <div className="card dup-bulk">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="dup-pick">
              <input
                type="checkbox"
                checked={shown.every((pair) => picked.has(pair.key))}
                onChange={() => toggleAll(shown)}
                aria-label="全选当前显示"
              />
              全选当前 {shown.length} 对
            </label>
            <span className="tiny muted">已选 {pickedPairs.length} 对 · {money(pickedAmount)} 元</span>
            {pairs.length > shown.length && (
              <button className="ghost small" type="button" onClick={() => toggleAll(pairs)}>选中全部 {pairs.length} 对</button>
            )}
            {pickedPairs.length > 0 && (
              <button className="ghost small" type="button" onClick={() => setPicked(new Set())}>清空选择</button>
            )}
            <span className="spacer" />
            <div className="segment" role="tablist">
              {[['earlier', '保留较早'], ['later', '保留较晚']].map(([value, label]) => (
                <button key={value} type="button" className={keepRule === value ? 'active' : ''} onClick={() => setKeepRule(value)}>{label}</button>
              ))}
            </div>
            <button className="secondary small" type="button" disabled={!pickedPairs.length || busy === 'bulk'} onClick={bulkIgnore}>不是重复</button>
            <button className="danger small" type="button" disabled={!pickedPairs.length || busy === 'bulk'} onClick={bulkResolve}>
              {busy === 'bulk' ? '处理中…' : `删除重复的 ${pickedPairs.length} 笔`}
            </button>
          </div>
        </div>
      )}
      <div className="list">
        {shown.map((pair) => (
          <div className={`card dup-pair${picked.has(pair.key) ? ' picked' : ''}`} key={pair.key}>
            <div className="dup-head">
              <label className="dup-pick">
                <input type="checkbox" checked={picked.has(pair.key)} onChange={() => toggle(pair.key)} aria-label="选择这一对" />
              </label>
              <b>{money(pair.amount)}</b>
              <span className="tag">{pair.score >= 90 ? '很像' : '可能'}</span>
              <span className="tiny muted">{pair.reasons.join(' · ')}</span>
              <div className="row" style={{ marginLeft: 'auto' }}>
                <button className="ghost" type="button" disabled={busy === pair.key} onClick={() => act(pair.key, () => api('/api/duplicates/ignore', { method: 'POST', body: { key: pair.key } }))}>不是重复</button>
              </div>
            </div>
            <div className="dup-sides">
              {[['a', pair.a], ['b', pair.b]].map(([side, tx]) => (
                <div className="dup-side" key={side}>
                  <div className="tiny muted">{formatWhen(tx.occurredAt)}</div>
                  <div className="dup-title">{tx.payee || tx.categoryName || '—'}</div>
                  <div className="tiny muted">
                    {[tx.accountName, tx.categoryName, tx.note].filter(Boolean).join(' · ')}
                  </div>
                  <button className="primary small" type="button" disabled={busy === pair.key} onClick={() => keep(pair, side)}>
                    保留这条
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {loading && !data && <div className="card"><p className="muted">正在查找…</p></div>}
        {data && pairs.length === 0 && <div className="card"><p className="muted">没有找到疑似重复的账单，试试放宽条件。</p></div>}
        {pairs.length > limit && (
          <div className="row">
            <span className="tiny muted">共 {pairs.length} 对，已显示 {limit} 对</span>
            <button className="secondary" type="button" onClick={() => setLimit((n) => n + 30)}>显示更多</button>
            <button className="ghost" type="button" onClick={() => setLimit(pairs.length)}>全部展开</button>
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
];

function BooksPage() {
  const { books, currentBookId, setCurrentBookId, reload } = useBooks();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('travel');
  const [memberInput, setMemberInput] = useState({});
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

  function create(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    run(
      () => api('/api/books', { method: 'POST', body: { name: trimmed, kind } }),
      (book) => { setName(''); return `已创建「${book.book.name}」`; },
    );
  }

  function rename(book) {
    const next = window.prompt('账本名', book.name);
    if (!next || next.trim() === book.name) return;
    run(() => api(`/api/books/${book.id}`, { method: 'PATCH', body: { name: next.trim() } }), () => '已改名');
  }

  function toggleShare(book) {
    run(
      () => api(`/api/books/${book.id}/share`, { method: 'POST', body: { enabled: !book.shareEnabled } }),
      (result) => (result.book.shareEnabled
        ? `分享已开启：${window.location.origin}/share/${result.book.shareToken}`
        : '分享已关闭，旧链接失效'),
    );
  }

  function copyLink(book) {
    const link = `${window.location.origin}/share/${book.shareToken}`;
    navigator.clipboard?.writeText(link);
    setNotice(`链接已复制：${link}`);
  }

  function addMember(book) {
    const username = String(memberInput[book.id] || '').trim();
    if (!username) return;
    run(
      () => api(`/api/books/${book.id}/members`, { method: 'POST', body: { username } }),
      () => { setMemberInput({ ...memberInput, [book.id]: '' }); return `已把 ${username} 加进「${book.name}」`; },
    );
  }

  function removeMember(book, member) {
    run(
      () => api(`/api/books/${book.id}/members/${member.id}`, { method: 'DELETE' }),
      () => `已移除 ${member.name}`,
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

  function BookCard({ book }) {
    const manage = book.role === 'owner' || book.role === 'admin';
    return (
      <div className={`card book-card${book.id === currentBookId ? ' active' : ''}`}>
        <div className="book-card-head">
          <div className="book-title">
            <b>{book.name}</b>
            <span className="tag">{book.kindLabel}</span>
            {book.archived && <span className="tag">已归档</span>}
          </div>
          <div className="book-meta-row">
            {book.role !== 'owner' && <span className="tiny muted">所有者 {book.ownerName}</span>}
            {book.id === currentBookId ? (
              <span className="badge-current">当前账本</span>
            ) : (
              <button className="secondary small" type="button" onClick={() => setCurrentBookId(book.id)}>切到这个账本</button>
            )}
          </div>
        </div>
        {manage && book.kind !== 'personal' && (
          <div className="book-section">
            <span className="book-section-title">成员</span>
            <div className="book-members">
              {book.members.map((member) => (
                <span className="cat-chip" key={member.id}>
                  <b>{member.name}</b>
                  {member.role === 'owner' ? <span className="tiny muted">所有者</span> : (
                    <button type="button" className="chip-btn danger" title="移除" onClick={() => removeMember(book, member)}>✕</button>
                  )}
                </span>
              ))}
            </div>
            <div className="book-add-member">
              <input
                value={memberInput[book.id] || ''}
                onChange={(e) => setMemberInput({ ...memberInput, [book.id]: e.target.value })}
                placeholder="用户名，加进来一起记"
              />
              <button className="secondary small" type="button" onClick={() => addMember(book)}>加成员</button>
            </div>
          </div>
        )}
        {manage && book.kind !== 'personal' && (
          <div className="book-section">
            <span className="book-section-title">共享</span>
            <div className="book-actions">
              <button className="secondary small" type="button" onClick={() => toggleShare(book)}>
                {book.shareEnabled ? '关闭分享' : '开启分享链接'}
              </button>
              {book.shareEnabled && (
                <button className="ghost small" type="button" onClick={() => copyLink(book)}>复制链接</button>
              )}
            </div>
            {book.shareEnabled && (
              <p className="book-link">
                免登录链接：{window.location.origin}/share/{book.shareToken}
              </p>
            )}
          </div>
        )}
        {manage && (
          <div className="book-actions">
            <button className="secondary small" type="button" onClick={() => rename(book)}>改名</button>
            <span className="spacer" />
            {book.kind !== 'personal' && (
              <button className="ghost danger-text small" type="button" onClick={() => removeBook(book)}>
                {book.archived ? '彻底删除' : '归档'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="page-head"><h1>账本</h1></div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <p className="muted" style={{ marginBottom: 12 }}>{notice}</p>}
      <div className="split books-layout">
        <section className="card">
          <h2>新建账本</h2>
          <form className="stack" onSubmit={create}>
            <label>账本名<input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如 泰国游、家里" required /></label>
            <label>类型
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {BOOK_KIND_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <button className="primary" type="submit">创建</button>
          </form>
          <p className="muted" style={{ marginTop: 12 }}>
            个人账本是你自己的，别人看不到；出游共享和家庭账本可以加成员，也能生成免登录链接让同伴补账。
          </p>
        </section>
        <section className="card">
          <h2>我的账本</h2>
          <div className="cat-list">
            {mine.map((book) => <BookCard key={book.id} book={book} />)}
            {mine.length === 0 && <p className="muted">还没有账本。</p>}
          </div>
          {others.length > 0 && (
            <>
              <h2 style={{ marginTop: 18 }}>其他人的账本（管理员可见）</h2>
              <div className="cat-list">
                {others.map((book) => <BookCard key={book.id} book={book} />)}
              </div>
            </>
          )}
        </section>
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
    </>
  );
}

function SharePage() {
  const rawToken = useParams().token || '';
  // 去除末尾标点/空格等常见复制污染，保留 base64url 字符
  const token = String(rawToken).replace(/[^A-Za-z0-9_-]/g, '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
    memberName: '',
    type: 'expense',
    amount: '',
    categoryLabel: '',
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
          images: imageList(form.images),
        },
      });
      setForm({ ...form, amount: '', categoryLabel: '', note: '', images: [] });
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

  const total = (data?.entries || []).reduce((sum, item) => (
    item.type === 'income' ? sum + Number(item.amount) : sum - Number(item.amount)
  ), 0);

  return (
    <div className="auth">
      <div className="share-page stack">
        <h1>{data ? data.book.name : '共享账本'}</h1>
        <p className="muted">{data ? `${data.book.kindLabel} · 补账不用登录，填个名字就行` : '正在打开…'}</p>
        {error && <div className="error">{error}</div>}
        {notice && <p className="muted">{notice}</p>}
        <form className="card stack" onSubmit={submit}>
          <div className="form-row wrap">
            <label>你的名字<input value={form.memberName} onChange={(e) => setForm({ ...form, memberName: e.target.value })} placeholder="小王" required /></label>
            <label>收支
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {[['expense', '我付的'], ['income', '我收的']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>金额<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
            <label>时间<input type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} /></label>
            <label>分类<input value={form.categoryLabel} onChange={(e) => setForm({ ...form, categoryLabel: e.target.value })} placeholder="门票 / 吃饭…" /></label>
          </div>
          <label>备注<textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          <div>
            <span className="tiny muted">图片（选完自动传图床，最多 9 张）</span>
            <ImagePicker
              images={form.images}
              onChange={(images) => setForm({ ...form, images })}
              uploadPath={`/api/share/${token}/upload`}
            />
          </div>
          <button className="primary" type="submit" disabled={saving}>{saving ? '保存中…' : '补一笔'}</button>
        </form>
        <section className="card">
          <div className="tree-head">
            <h2>已记 {data?.entries.length || 0} 笔</h2>
            <b>{total.toFixed(2)} 元</b>
          </div>
          <div className="list">
            {(data?.entries || []).map((item) => (
              <div className="item" key={item.id}>
                <div>
                  <div>{item.memberName} · {item.categoryName || item.categoryLabel || '未分类'}</div>
                  <div className="tiny muted">{formatWhen(item.occurredAt)}{item.note ? ` · ${item.note}` : ''}</div>
                  {item.images?.length > 0 && (
                    <div className="image-grid">
                      {item.images.map((url) => (
                        <a key={url} href={imageSrc(url)} target="_blank" rel="noreferrer">
                          <img src={imageSrc(url)} alt="" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <b className={item.type === 'income' ? 'income' : 'expense'}>
                  {item.type === 'income' ? '+' : '-'}{money(item.amount)}
                </b>
              </div>
            ))}
            {(data?.entries || []).length === 0 && <p className="muted">还没有人补账。</p>}
          </div>
        </section>
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
          <Route path="/books" element={<BooksPage />} />
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/users" element={user.isAdmin ? <UsersPage /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </RefreshContext.Provider>
  );
}

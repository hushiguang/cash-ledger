import crypto from 'node:crypto';
import { db } from './db.js';

export const BOOK_KINDS = ['personal', 'travel', 'family'];

export function bookKindLabel(kind) {
  return { personal: '个人', travel: '出游共享', family: '家庭' }[kind] || '账本';
}

export function presentBook(row, { role = null, ownerName = '', members = [] } = {}) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: bookKindLabel(row.kind),
    ownerId: row.owner_id,
    ownerName,
    role: role || (row.owner_id ? null : null),
    archived: !!row.archived,
    shareEnabled: !!row.share_enabled,
    shareToken: row.share_token || '',
    members,
  };
}

export function bookById(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(Number(id)) || null;
}

export function bookMembers(bookId) {
  return db.prepare(`
    SELECT m.user_id, m.role, u.display_name, u.username
    FROM book_members m JOIN users u ON u.id = m.user_id
    WHERE m.book_id = ? ORDER BY m.id
  `).all(Number(bookId));
}

export function ensurePersonalBook(userId) {
  const found = db.prepare(
    "SELECT * FROM books WHERE owner_id = ? AND kind = 'personal'",
  ).get(userId);
  if (found) return found;
  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO books (owner_id, name, kind, created_at) VALUES (?, ?, ?, ?)',
  ).run(userId, '个人账本', 'personal', now);
  db.prepare(
    'INSERT OR IGNORE INTO book_members (book_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run(Number(info.lastInsertRowid), userId, 'owner', now);
  return bookById(Number(info.lastInsertRowid));
}

// 我能看到的账本：自己建的 + 被加为成员的
export function visibleBookIds(userId) {
  const rows = db.prepare(`
    SELECT id FROM books WHERE owner_id = ?
    UNION
    SELECT book_id AS id FROM book_members WHERE user_id = ?
  `).all(userId, userId);
  return rows.map((row) => row.id);
}

export function canSeeBook(user, bookId) {
  const row = bookById(bookId);
  if (!row) return null;
  if (user.isAdmin) return row;
  if (row.owner_id === user.id) return row;
  const member = db.prepare('SELECT id FROM book_members WHERE book_id = ? AND user_id = ?').get(row.id, user.id);
  return member ? row : null;
}

// 能改设置/成员/分享/删除的：owner 或管理员
export function canManageBook(user, row) {
  if (!row) return false;
  return user.isAdmin || row.owner_id === user.id;
}

// 能往里记账的：owner、成员、管理员
export function canWriteBook(user, row) {
  if (!row) return false;
  if (user.isAdmin || row.owner_id === user.id) return true;
  return !!db.prepare('SELECT id FROM book_members WHERE book_id = ? AND user_id = ?').get(row.id, user.id);
}

export function roleInBook(user, row) {
  if (!row) return null;
  if (row.owner_id === user.id) return 'owner';
  const member = db.prepare('SELECT role FROM book_members WHERE book_id = ? AND user_id = ?').get(row.id, user.id);
  return member ? member.role : (user.isAdmin ? 'admin' : null);
}

export function newShareToken() {
  return crypto.randomBytes(9).toString('base64url');
}

export function bookByShareToken(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  return db.prepare('SELECT * FROM books WHERE share_token = ? AND share_enabled = 1').get(key) || null;
}

export function transactionImages(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM transaction_images WHERE transaction_id IN (${marks}) ORDER BY sort, id
  `).all(...ids);
  for (const row of rows) {
    const list = map.get(row.transaction_id) || [];
    list.push(row.url);
    map.set(row.transaction_id, list);
  }
  return map;
}

export function saveImages(transactionId, images) {
  if (!Array.isArray(images)) return;
  db.prepare('DELETE FROM transaction_images WHERE transaction_id = ?').run(transactionId);
  const insert = db.prepare(
    'INSERT INTO transaction_images (transaction_id, url, sort, created_at) VALUES (?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  images
    .map((url) => String(url || '').trim())
    .filter(Boolean)
    .slice(0, 9)
    .forEach((url, i) => insert.run(transactionId, url, i, now));
}

import { db } from './db.js';

export function listCmbTextFixes(userId) {
  return db.prepare(
    'SELECT id, garbled, correct, enabled, position FROM cmb_text_fixes WHERE user_id = ? ORDER BY position, id',
  ).all(userId);
}

// 解析 CMB PDF 时按当前用户取「启用中」的修复映射，按 position 顺序执行。
export function getCmbGarbleFixes(userId) {
  return db.prepare(
    'SELECT garbled, correct FROM cmb_text_fixes WHERE user_id = ? AND enabled = 1 ORDER BY position, id',
  ).all(userId);
}

export function createCmbTextFix(userId, { garbled, correct, position = 0, enabled = 1 }) {
  const g = String(garbled || '').trim();
  const c = String(correct || '').trim();
  if (!g) throw new Error('乱码片段不能为空');
  const info = db.prepare(`
    INSERT INTO cmb_text_fixes (user_id, garbled, correct, enabled, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, g, c, enabled ? 1 : 0, Number(position) || 0, new Date().toISOString());
  return db.prepare('SELECT id, garbled, correct, enabled, position FROM cmb_text_fixes WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function updateCmbTextFix(userId, id, fields) {
  const existing = db.prepare('SELECT * FROM cmb_text_fixes WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!existing) throw new Error('规则不存在');
  const garbled = fields.garbled != null ? String(fields.garbled).trim() : existing.garbled;
  const correct = fields.correct != null ? String(fields.correct).trim() : existing.correct;
  const enabled = fields.enabled != null ? (fields.enabled ? 1 : 0) : existing.enabled;
  const position = fields.position != null ? Number(fields.position) || 0 : existing.position;
  db.prepare(`
    UPDATE cmb_text_fixes SET garbled = ?, correct = ?, enabled = ?, position = ? WHERE id = ?
  `).run(garbled, correct, enabled, position, Number(id));
  return db.prepare('SELECT id, garbled, correct, enabled, position FROM cmb_text_fixes WHERE id = ?').get(Number(id));
}

export function deleteCmbTextFix(userId, id) {
  db.prepare('DELETE FROM cmb_text_fixes WHERE id = ? AND user_id = ?').run(Number(id), userId);
}

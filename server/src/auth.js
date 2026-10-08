import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { dataDirPath, db } from './db.js';

function secretPath() {
  return path.join(dataDirPath(), 'jwt.secret');
}

export function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = secretPath();
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret);
  return secret;
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function checkPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function signUser(user) {
  return jwt.sign({ id: user.id, username: user.username }, jwtSecret(), { expiresIn: '14d' });
}

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: !!row.is_admin,
    isActive: !!row.is_active,
    createdAt: row.created_at,
  };
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ message: '请先登录' });
  try {
    const payload = jwt.verify(token, jwtSecret());
    const row = db.prepare(
      'SELECT id, username, display_name, is_admin, is_active, created_at FROM users WHERE id = ?',
    ).get(payload.id);
    if (!row || !row.is_active) return res.status(401).json({ message: '账号不可用' });
    req.user = publicUser(row);
    return next();
  } catch {
    return res.status(401).json({ message: '登录已过期' });
  }
}

export function adminRequired(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ message: '需要管理员权限' });
  return next();
}

export function allowRegister() {
  return process.env.ALLOW_REGISTER !== 'false';
}

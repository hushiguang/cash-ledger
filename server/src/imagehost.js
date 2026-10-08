// 图床：EasyImages2.0（https://github.com/icret/EasyImages2.0）
// 上传走服务端转发，token 不落到前端；展示也走服务端代理，绕开自签证书导致浏览器加载失败。

import https from 'node:https';
import http from 'node:http';
import { Buffer } from 'node:buffer';

const HOST_URL = process.env.IMAGE_HOST_URL || 'https://image.coooo.tech:1443/api/index.php';
const HOST_TOKEN = process.env.IMAGE_HOST_TOKEN || '1c17b11693cb5ec63859b091c5b9c1b2';
// 图片代理只允许回源到图床，避免变成任意 URL 抓取
const ALLOWED_HOSTS = new Set(
  String(process.env.IMAGE_HOST_ALLOW_HOSTS || 'image.coooo.tech').split(',').map((s) => s.trim()).filter(Boolean),
);
const MAX_BYTES = 12 * 1024 * 1024;

export const imageHostConfigured = Boolean(HOST_TOKEN);

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'http:' ? http : https;
    // 图床用的是自签证书，只在这里放过校验
    const req = lib.request(url, { rejectUnauthorized: false, ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('图床超时')));
    if (body) req.write(body);
    req.end();
  });
}

export async function uploadImage({ buffer, mimetype, filename }) {
  if (!imageHostConfigured) throw Object.assign(new Error('图床还没配置'), { status: 500 });
  if (!buffer?.length) throw Object.assign(new Error('没有选到图片'), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('图片太大了（最多 12MB）'), { status: 400 });
  const boundary = `----qingji${Date.now()}${Math.random().toString(16).slice(2)}`;
  const safeName = String(filename || 'image').replace(/[^\w.\-]/g, '_').slice(-80) || 'image';
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${HOST_TOKEN}\r\n`));
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safeName}"\r\n`
    + `Content-Type: ${mimetype || 'application/octet-stream'}\r\n\r\n`,
  ));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const url = new URL(HOST_URL);
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  }, body);
  let data = {};
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('图床返回看不懂'), { status: 502 });
  }
  if (data.result !== 'success' || !data.url) {
    throw Object.assign(new Error(data.message || '上传失败'), { status: 502 });
  }
  return { url: data.url, thumb: data.thumb || data.url, del: data.del || '', name: data.srcName || safeName };
}

export function isAllowedImageUrl(url) {
  try {
    const parsed = new URL(String(url));
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export async function fetchImage(url) {
  const res = await request(new URL(url), { method: 'GET' });
  if (res.status !== 200) throw Object.assign(new Error('取不到这张图'), { status: 502 });
  return { body: res.body, contentType: res.headers['content-type'] || 'image/*' };
}

// 前端展示统一走这里：/api/image?u=<原图地址>
export function proxiedImageUrl(url) {
  return `/api/image?u=${encodeURIComponent(url || '')}`;
}

import { Preferences } from '@capacitor/preferences';

/**
 * 请求层。
 *
 * 三种运行环境共用一套代码：
 * - 浏览器开发：base 为空，走 vite 的 /api 代理
 * - Docker 部署：base 为空，同源
 * - iOS / Android（Capacitor）：base 为空会请求 capacitor 本地域，必须配置后端地址
 *   （设置页里填，或构建时用 VITE_API_BASE 写死）
 */

const TOKEN_KEY = 'qingji.token';
const API_BASE_KEY = 'qingji.apiBase';

/** token 同步缓存：偏好存储是异步的，但请求头要同步拿 */
let tokenCache: string | null = null;

/** 启动时调用一次：把原生偏好存储里的 token 读进内存 */
export async function initTokenStore(): Promise<void> {
  try {
    const { value } = await Preferences.get({ key: TOKEN_KEY });
    if (value) {
      tokenCache = value;
      localStorage.setItem(TOKEN_KEY, value);
      return;
    }
  } catch {
    /* web 环境或插件不可用，退回 localStorage */
  }
  tokenCache = localStorage.getItem(TOKEN_KEY);
}

export function getToken(): string {
  if (tokenCache === null) tokenCache = localStorage.getItem(TOKEN_KEY);
  return tokenCache || '';
}

export function setToken(token?: string | null): void {
  tokenCache = token || '';
  if (tokenCache) localStorage.setItem(TOKEN_KEY, tokenCache);
  else localStorage.removeItem(TOKEN_KEY);
  void Preferences.set({ key: TOKEN_KEY, value: tokenCache }).catch(() => {});
}

export function getApiBase(): string {
  return (localStorage.getItem(API_BASE_KEY) || import.meta.env.VITE_API_BASE || '').trim();
}

export function setApiBase(url: string): void {
  const value = url.trim().replace(/\/+$/, '');
  if (value) localStorage.setItem(API_BASE_KEY, value);
  else localStorage.removeItem(API_BASE_KEY);
}

/** 把 /api/xxx 拼成可直连后端的绝对地址；没配 base 就原样返回（同源/代理） */
export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = getApiBase();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

// 全局 loading：所有请求都走这里计数，界面顶部显示一条进度条
const busyListeners = new Set<(count: number) => void>();
let busyCount = 0;

function emitBusy(): void {
  busyListeners.forEach((listener) => listener(busyCount));
}

export function subscribeBusy(listener: (count: number) => void): () => void {
  busyListeners.add(listener);
  listener(busyCount);
  return () => busyListeners.delete(listener);
}

/** 把一个 promise 计入全局 loading，导出/上传这类不走 api() 的请求也能用 */
export function track<T>(promise: Promise<T>): Promise<T> {
  busyCount += 1;
  emitBusy();
  return promise.finally(() => {
    busyCount = Math.max(0, busyCount - 1);
    emitBusy();
  });
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** 不自动带 Content-Type（例如自己构造 FormData 时其实无所谓，留作兜底） */
  rawBody?: boolean;
}

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...((options.headers as Record<string, string>) || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body = options.body;
  if (body !== undefined && !(body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...options, headers, body: body as BodyInit });
  } catch (err) {
    // 最常见的就是 App 里后端地址没配/不可达，给一句人话
    throw new ApiError(getApiBase() ? '连不上服务器，检查设置里的地址' : '网络请求失败', 0, err);
  }

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown> & T;
  if (!response.ok) {
    throw new ApiError((data.message as string) || '请求失败', response.status, data);
  }
  return data;
}

/** 类型化请求：api<{ bills: Bill[] }>('/api/bills') */
export function api<T = Record<string, unknown>>(path: string, options: ApiOptions = {}): Promise<T> {
  return track(request<T>(path, options));
}

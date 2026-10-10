const TOKEN_KEY = 'qingji.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// 全局 loading：所有请求都走这里计数，界面顶部显示一条进度条
const busyListeners = new Set();
let busyCount = 0;

function emitBusy() {
  busyListeners.forEach((listener) => listener(busyCount));
}

export function subscribeBusy(listener) {
  busyListeners.add(listener);
  listener(busyCount);
  return () => busyListeners.delete(listener);
}

// 把一个 promise 计入全局 loading，导出/上传这类不走 api() 的请求也能用
export function track(promise) {
  busyCount += 1;
  emitBusy();
  return promise.finally(() => {
    busyCount = Math.max(0, busyCount - 1);
    emitBusy();
  });
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || '请求失败');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function api(path, options = {}) {
  return track(request(path, options));
}

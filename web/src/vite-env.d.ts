/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 构建时写入的后端地址；不填则同源（浏览器/代理），App 里由用户在设置页配置 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

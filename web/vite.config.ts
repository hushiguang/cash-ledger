import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 新代码统一用 @/ 引用 src，避免 ../../ 这种相对路径
const srcPath = new URL('./src/', import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': srcPath },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
  build: {
    // iOS 14+ / Android 8+ 的 WebView 都能跑；再低会缺可选链等语法
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});

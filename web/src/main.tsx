import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.jsx';
import './styles.css';
import { initTokenStore } from './api';
import { initH5Shell, initNativeShell, syncStatusBar } from './platform';

// 原生壳：先把 token 从 Preferences 读进内存，再初始化状态栏 / 键盘 / 返回键
void (async () => {
  await initTokenStore();
  await initNativeShell();
  initH5Shell();
})();

// 主题切换后同步状态栏文字颜色（data-resolved 由主题逻辑写在 <html> 上）
new MutationObserver(() => {
  void syncStatusBar();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-resolved'] });

const container = document.getElementById('root');
if (!container) throw new Error('#root 节点缺失');

createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.leo.qingji',
  appName: '轻账单',
  webDir: 'dist',
  ios: {
    // 内容延伸到状态栏下面，顶部留白交给 CSS 的 env(safe-area-inset-top)
    contentInset: 'always',
  },
  android: {
    // 自建 / 内网 http 后端要允许明文，否则 WebView 直接拦掉
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;

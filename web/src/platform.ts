import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

/**
 * 原生壳能力封装。web 下所有 Capacitor 调用都会走插件自带的 web 实现或静默失败，
 * 所以页面里可以无条件调用，不用到处判环境。
 */

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as 'ios' | 'android' | 'web';

/** 内容绘制到状态栏下面（overlay），由 CSS 的 safe-area 自己留白 */
export async function initNativeShell(): Promise<void> {
  if (!isNative) return;

  // 给 CSS 一个钩子：html[data-native='1'] 下的规则只在 App 里生效
  document.documentElement.dataset.native = '1';

  await SplashScreen.hide().catch(() => {});
  await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
  await syncStatusBar();

  // iOS 键盘上方不要工具条；键盘弹起时交给 WebView 自己缩，不要整页平移
  await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {});
  await Keyboard.setScroll({ isDisabled: true }).catch(() => {});
  await Keyboard.setResizeMode({ mode: 'native' as never }).catch(() => {});

  // Android 返回键：先广播给页面（关弹窗/回上一步），没人接才退出
  await App.addListener('backButton', ({ canGoBack }) => {
    const event = new CustomEvent('capacitor:back', { cancelable: true, detail: { canGoBack } });
    const handled = !window.dispatchEvent(event);
    if (handled) return;
    if (canGoBack) window.history.back();
    else void App.exitApp();
  }).catch(() => {});

  // 深链接 / 通用链接：qingji://share/<token> 或 https://xxx/share/<token> 交给前端路由
  await App.addListener('appUrlOpen', (event) => {
    const path = toPath(event.url);
    if (!path) return;
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }).catch(() => {});

  await App.addListener('appStateChange', ({ isActive }) => {
    document.documentElement.dataset.appActive = String(isActive);
  }).catch(() => {});
}

function toPath(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // qingji://share/xxx → /share/xxx
    if (parsed.protocol === 'qingji:') return `/${parsed.host}${parsed.pathname}`.replace(/\/+/g, '/');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url.startsWith('/') ? url : null;
  }
}

/**
 * 手机浏览器：键盘弹起时收起底栏和悬浮按钮，避免挡住正在输入的框。
 * visualViewport 比 window 矮一截，就当成键盘开着。
 */
export function initH5Shell(): void {
  if (isNative || !window.visualViewport) return;
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const sync = () => {
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const keyboard = narrow && window.innerHeight - viewport.height > 140;
    root.dataset.keyboard = keyboard ? '1' : '0';
  };
  viewport.addEventListener('resize', sync);
  viewport.addEventListener('scroll', sync);
  window.addEventListener('orientationchange', sync);
  sync();
}

/** 跟随主题切换状态栏文字颜色 */
export async function syncStatusBar(): Promise<void> {
  if (!isNative) return;
  const dark = document.documentElement.dataset.resolved === 'dark';
  await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
}

export async function impact(style: ImpactStyle = ImpactStyle.Light): Promise<void> {
  if (!isNative) return;
  await Haptics.impact({ style }).catch(() => {});
}

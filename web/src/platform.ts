import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
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

  // 深链接 / 通用链接：qingji://share/<token> 或 https://xxx/share/<token> 交给前端路由。
  // qingji://bill 是付款通知拉起的记一笔，不进路由。
  await App.addListener('appUrlOpen', (event) => {
    if (publishPayDraft(event.url)) return;
    const path = toPath(event.url);
    if (!path) return;
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }).catch(() => {});

  const launch = await App.getLaunchUrl().catch(() => undefined);
  if (launch?.url) publishPayDraft(launch.url);

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

interface QingjiNativePlugin {
  openAccessibilitySettings(): Promise<void>;
  openNotificationSettings(): Promise<void>;
  openPopupSettings(): Promise<void>;
  openPayApp(options: { source: string }): Promise<void>;
  lastNotice(): Promise<{ text?: string }>;
}

const QingjiNative = registerPlugin<QingjiNativePlugin>('QingjiNative');

/** 跳到系统「通知使用权」。微信通知正文要靠这项才能读到。 */
export async function openPayNotifySettings(): Promise<void> {
  if (!isNative) return;
  await QingjiNative.openNotificationSettings().catch(() => {});
}

/** 无障碍「轻账单付款通知」。付款页还在前面时，由它把记一笔拉起来。 */
export async function openPayAccessibilitySettings(): Promise<void> {
  if (!isNative) return;
  await QingjiNative.openAccessibilitySettings().catch(() => {});
}

/** 打开微信或支付宝。停在付款详情页时，无障碍会把对方、时间和单号读回来。 */
export async function openPayApp(source: 'wechat' | 'alipay'): Promise<void> {
  if (!isNative) return;
  await QingjiNative.openPayApp({ source }).catch(() => {});
}

/** 小米「后台弹出界面」。不开这项，读到付款也拉不起记一笔。 */
export async function openPayPopupSettings(): Promise<void> {
  if (!isNative) return;
  await QingjiNative.openPopupSettings().catch(() => {});
}

export async function lastPayNotice(): Promise<string> {
  if (!isNative) return '';
  const result = await QingjiNative.lastNotice().catch(() => null);
  return result?.text || '';
}

export interface PayDraft {
  id: number;
  amount: string;
  payee: string;
  note: string;
  occurredAt: string;
  type: 'expense' | 'income';
  source: 'wechat' | 'alipay';
}

const PAY_DRAFT_KEY = 'qingji.payDraft';
const PAY_DRAFT_SEEN_KEY = 'qingji.payDraftSeen';

/** 付款通知拉起：qingji://bill?amount=&payee=&type=&source=&id= */
function publishPayDraft(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'qingji:' || parsed.hostname !== 'bill') return false;
  const amount = parsed.searchParams.get('amount') || '';
  if (!amount) return true;
  const id = Number(parsed.searchParams.get('id') || Date.now());
  if (sessionStorage.getItem(PAY_DRAFT_SEEN_KEY) === String(id)) return true;
  const draft: PayDraft = {
    id,
    amount,
    payee: parsed.searchParams.get('payee') || '',
    note: parsed.searchParams.get('note') || '',
    occurredAt: parsed.searchParams.get('occurredAt') || '',
    type: parsed.searchParams.get('type') === 'income' ? 'income' : 'expense',
    source: parsed.searchParams.get('source') === 'alipay' ? 'alipay' : 'wechat',
  };
  sessionStorage.setItem(PAY_DRAFT_SEEN_KEY, String(id));
  sessionStorage.setItem(PAY_DRAFT_KEY, JSON.stringify(draft));
  window.dispatchEvent(new CustomEvent('qingji:payDraft', { detail: draft }));
  return true;
}

export function consumePayDraft(): PayDraft | null {
  const raw = sessionStorage.getItem(PAY_DRAFT_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PAY_DRAFT_KEY);
  try {
    const draft = JSON.parse(raw) as PayDraft;
    return draft?.amount ? draft : null;
  } catch {
    return null;
  }
}

export async function impact(style: ImpactStyle = ImpactStyle.Light): Promise<void> {
  if (!isNative) return;
  await Haptics.impact({ style }).catch(() => {});
}

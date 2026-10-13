package com.leo.qingji;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Notification;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Parcelable;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.lang.ref.WeakReference;
import java.util.List;

/**
 * 小米只允许在无障碍回调里把页面拉到前台。通知监听负责认金额，这里负责弹出。
 */
public class PaymentAccessibilityService extends AccessibilityService {
    private static final String WECHAT = "com.tencent.mm";
    private static final String ALIPAY = "com.eg.android.AlipayGphone";
    private static WeakReference<PaymentAccessibilityService> current;
    private static Intent pending;
    private static long pendingAt;
    private static boolean watching;
    /** 付款通知刚到之后的几秒。这段时间里读到付款页就拉起记账。 */
    private static long awaitUntil;
    private final Handler main = new Handler(Looper.getMainLooper());
    private long lastScan;
    private int walked;
    private String foregroundClass = "";

    @Override
    protected void onServiceConnected() {
        current = new WeakReference<>(this);
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            int flags = info.flags
                    | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            if (flags != info.flags) {
                info.flags = flags;
                setServiceInfo(info);
            }
        }
        android.util.Log.i("QingjiPay", "无障碍已连接");
    }

    @Override
    public void onDestroy() {
        if (current != null && current.get() == this) current = null;
        super.onDestroy();
    }

    /** 只记下要打开的页面。拉起放到读到付款详情的那一次无障碍回调里。 */
    static void arm(Intent intent) {
        if (intent == null) return;
        pending = new Intent(intent);
        pendingAt = SystemClock.elapsedRealtime();
        if (current == null || current.get() == null) {
            android.util.Log.i("QingjiPay", "无障碍未开启");
            return;
        }
        android.util.Log.i("QingjiPay", "无障碍已记下，等付款详情再拉起");
    }

    /** 用无障碍服务自己的上下文拉起。通知监听里的 startActivity 小米不会把页面放到微信前面。 */
    static boolean launchPending() {
        PaymentAccessibilityService service = current == null ? null : current.get();
        if (service == null || pending == null) return false;
        service.launch(pending, true);
        return true;
    }

    /** 用户点了去微信识别。在读到对方或单号之前，不要把轻账单拉回来。 */
    static void watchDetail() {
        watching = true;
        pending = null;
        android.util.Log.i("QingjiPay", "去微信读取详情，读到对方后再回来");
    }

    /** 新的付款通知到了，结束「去微信识别」的等待。 */
    static void stopWatching() {
        watching = false;
    }

    /** 付款通知刚到。接下来几秒里读到付款页，就拉起记账。 */
    static void awaitPage() {
        awaitUntil = SystemClock.elapsedRealtime() + 8000;
        android.util.Log.i("QingjiPay", "付款通知到了，读到页面就拉起记账");
        readScreen();
    }

    /**
     * 通知监听里直接 startActivity，小米不会把记账页盖到支付宝上。
     * 无障碍可以先在最上层放一个自己的窗口，系统才允许接着把记账页拉起来。
     */
    static boolean bring(Intent bill) {
        PaymentAccessibilityService service = current == null ? null : current.get();
        if (service == null || bill == null) return false;
        Intent copy = new Intent(bill);
        if (Looper.myLooper() == Looper.getMainLooper()) service.overlayThenStart(copy);
        else service.main.post(() -> service.overlayThenStart(copy));
        return true;
    }

    static void readScreen() {
        PaymentAccessibilityService service = current == null ? null : current.get();
        if (service == null) return;
        service.main.post(service::readAndBring);
    }

    private void overlayThenStart(Intent bill) {
        WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        View dot = new View(this);
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                1, 1,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.START | Gravity.TOP;
        boolean added = false;
        if (wm != null) {
            try {
                wm.addView(dot, lp);
                added = true;
                android.util.Log.i("QingjiPay", "已铺无障碍窗口，准备拉起记账");
            } catch (RuntimeException error) {
                android.util.Log.e("QingjiPay", "无障碍窗口失败", error);
            }
        }
        PaymentLauncher.cover(this, bill);
        if (added) {
            View layer = dot;
            dot.postDelayed(() -> {
                try {
                    wm.removeView(layer);
                } catch (RuntimeException ignored) {
                }
            }, 2000);
        }
    }

    private void readAndBring() {
        if (Build.VERSION.SDK_INT < 21) return;
        List<AccessibilityWindowInfo> windows = getWindows();
        if (windows == null) return;
        StringBuilder text = new StringBuilder();
        String pkg = "";
        walked = 0;
        for (AccessibilityWindowInfo window : windows) {
            AccessibilityNodeInfo root = window.getRoot();
            if (root != null && root.getPackageName() != null) {
                String name = root.getPackageName().toString();
                if (WECHAT.equals(name) || ALIPAY.equals(name)) {
                    pkg = name;
                    appendTree(root, text);
                }
            }
            if (root != null) root.recycle();
            window.recycle();
        }
        android.util.Log.i("QingjiPay", "通知后读屏幕 " + text.length());
        if (!pkg.isEmpty()) openIfPayment(pkg, text.toString());
    }

    private static boolean awaiting() {
        return awaitUntil != 0 && SystemClock.elapsedRealtime() < awaitUntil;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        int type = event.getEventType();
        if (!watching) launchIfArmed(event);
        if (type == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) {
            handleNotification(event);
            return;
        }
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                || type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            scanWindow(event);
        }
    }

    private void handleNotification(AccessibilityEvent event) {
        String pkg = event.getPackageName() == null ? "" : event.getPackageName().toString();
        StringBuilder text = new StringBuilder();
        if (event.getText() != null) {
            for (CharSequence part : event.getText()) PaymentTexts.append(text, part);
        }
        PaymentTexts.append(text, event.getContentDescription());
        Parcelable parcel = event.getParcelableData();
        if (parcel instanceof Notification) {
            PaymentTexts.append(text, PaymentTexts.from((Notification) parcel));
        }
        openIfPayment(pkg, text.toString());
    }

    private void scanWindow(AccessibilityEvent event) {
        String pkg = event.getPackageName() == null ? "" : event.getPackageName().toString();
        if (!WECHAT.equals(pkg) && !ALIPAY.equals(pkg)) return;
        String cls = event.getClassName() == null ? "" : event.getClassName().toString();
        boolean stateChanged = event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
        if (stateChanged && cls.contains(".")) foregroundClass = cls;
        boolean billPage = isBillClass(foregroundClass) || isBillClass(cls);
        long now = SystemClock.elapsedRealtime();
        if (!stateChanged && now - lastScan < 300) return;
        StringBuilder text = new StringBuilder();
        if (event.getText() != null) {
            for (CharSequence part : event.getText()) PaymentTexts.append(text, part);
        }
        String preview = text.toString();
        boolean looksPay = stateChanged || billPage || watching || awaiting()
                || preview.contains("支付")
                || preview.contains("付款")
                || preview.contains("交易")
                || preview.contains("订单金额")
                || preview.contains("¥")
                || preview.contains("￥");
        if (!looksPay && pending == null) return;
        lastScan = now;
        walked = 0;
        readPayWindow(event, pkg, text);
        String raw = text.toString();
        if (billPage || raw.contains("支付成功") || raw.contains("交易成功") || raw.contains("订单金额") || raw.contains("转账单号") || raw.contains("给")) {
            android.util.Log.i("QingjiPay", "读到付款页 " + foregroundClass + "：" + clip(raw));
        }
        openIfPayment(pkg, raw);
    }

    private static boolean isBillClass(String cls) {
        return cls.contains("Remittance") || cls.contains("Wallet") || cls.contains("UIPageFragment");
    }

    private void openIfPayment(String pkg, String raw) {
        String source = sourceOf(pkg, raw);
        if (source == null) return;
        PaymentParser.Notice notice = PaymentParser.parse(source, raw);
        if (notice == null) {
            if (raw.contains("支付") || raw.contains("付款")) {
                PaymentLauncher.remember(this, source, raw);
            }
            return;
        }
        android.util.Log.i("QingjiPay", "无障碍看到付款：" + notice.amount + " 对方 " + notice.merchant);
        boolean rich = !notice.merchant.isEmpty() || !notice.orderNo.isEmpty() || !notice.occurredAt.isEmpty()
                || notice.note.contains("支付方式")
                || raw.contains("支付成功") || raw.contains("付款成功") || raw.contains("转账单号") || raw.contains("账单详情");
        boolean fresh = awaiting();
        boolean justPaid = raw.contains("支付成功") && (raw.contains("付款方式") || raw.contains("支付方式") || raw.contains("转账单号"));
        if (fresh && !rich && !justPaid) return;
        if (!watching && !fresh && !justPaid) {
            PaymentLauncher.remember(this, source, raw);
            android.util.Log.i("QingjiPay", "看到付款页，用户自己打开的，不拉回账本");
            return;
        }
        if (watching && !rich && !fresh) {
            android.util.Log.i("QingjiPay", "详情还没读全，先留在微信");
            return;
        }
        watching = false;
        awaitUntil = 0;
        PaymentLauncher.comeBack(this, notice, raw);
    }

    private void launchIfArmed(AccessibilityEvent event) {
        Intent waiting = pending;
        if (waiting == null) return;
        if (SystemClock.elapsedRealtime() - pendingAt > 20000) {
            pending = null;
            return;
        }
        String pkg = event.getPackageName() == null ? "" : event.getPackageName().toString();
        if (!WECHAT.equals(pkg) && !ALIPAY.equals(pkg)) return;
        launch(waiting, true);
    }

    private void launch(Intent waiting, boolean consume) {
        if (waiting == null) return;
        try {
            PaymentLauncher.cover(this, waiting);
            if (consume) pending = null;
            android.util.Log.i("QingjiPay", "无障碍已拉起页面");
        } catch (RuntimeException error) {
            android.util.Log.e("QingjiPay", "无障碍拉起失败", error);
        }
    }

    /** 只读微信或支付宝自己的窗口。当前焦点如果在桌面，不能把桌面图标当成付款页。 */
    private void readPayWindow(AccessibilityEvent event, String pkg, StringBuilder text) {
        AccessibilityNodeInfo source = event.getSource();
        if (belongsTo(source, pkg)) appendTree(source, text);
        if (source != null) source.recycle();
        String got = text.toString();
        if (got.contains("支付成功") && got.contains("付款方式")) return;
        if (got.contains("付款成功") && got.contains("付款方式")) return;
        if (Build.VERSION.SDK_INT < 21) return;
        List<AccessibilityWindowInfo> windows = getWindows();
        if (windows == null) return;
        for (AccessibilityWindowInfo window : windows) {
            AccessibilityNodeInfo root = window.getRoot();
            if (belongsTo(root, pkg)) appendTree(root, text);
            if (root != null) root.recycle();
            window.recycle();
        }
    }

    private static boolean belongsTo(AccessibilityNodeInfo node, String pkg) {
        return node != null && node.getPackageName() != null && pkg.contentEquals(node.getPackageName());
    }

    private void appendTree(AccessibilityNodeInfo node, StringBuilder text) {
        if (node == null || walked > 500 || text.length() > 2500) return;
        walked++;
        PaymentTexts.append(text, node.getText());
        PaymentTexts.append(text, node.getContentDescription());
        int count = Math.min(node.getChildCount(), 30);
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            appendTree(child, text);
            if (child != null) child.recycle();
        }
    }

    private static String clip(String raw) {
        String text = raw == null ? "" : raw.replace('\n', ' ').trim();
        if (text.length() > 180) return text.substring(0, 180);
        return text;
    }

    @Override
    public void onInterrupt() {}

    private static String sourceOf(String pkg, String raw) {
        if (WECHAT.equals(pkg)) return "wechat";
        if (ALIPAY.equals(pkg)) return "alipay";
        if (raw.contains("微信支付") || raw.contains("微信付款") || raw.contains("微信收款")) return "wechat";
        if (raw.contains("支付宝")) return "alipay";
        return null;
    }
}

package com.leo.qingji;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import java.lang.ref.WeakReference;

/**
 * 通知使用权。新系统上无障碍收不到微信通知正文，这条服务才能读到标题和金额。
 */
public class PaymentNotifyListener extends NotificationListenerService {
    private static final String TAG = "QingjiPay";
    private static final String WECHAT = "com.tencent.mm";
    private static final String ALIPAY = "com.eg.android.AlipayGphone";
    private static PendingIntent lastBill;
    private static WeakReference<PaymentNotifyListener> current;

    @Override
    public void onListenerConnected() {
        current = new WeakReference<>(this);
        super.onListenerConnected();
        StatusBarNotification[] active = null;
        try {
            active = getActiveNotifications();
        } catch (RuntimeException error) {
            Log.e(TAG, "读取当前通知失败", error);
        }
        int count = active == null ? 0 : active.length;
        Log.i(TAG, "监听已连接，当前通知 " + count + " 条");
        if (active == null) return;
        for (StatusBarNotification posted : active) handle(posted, "已有");
    }

    @Override
    public void onListenerDisconnected() {
        Log.i(TAG, "监听断开，准备重连");
        if (Build.VERSION.SDK_INT >= 24) {
            requestRebind(new ComponentName(this, PaymentNotifyListener.class));
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification posted) {
        handle(posted, "新");
    }

    @Override
    public void onNotificationPosted(StatusBarNotification posted, RankingMap rankingMap) {
        handle(posted, "新");
    }

    private void handle(StatusBarNotification posted, String when) {
        if (posted == null || posted.getNotification() == null) return;
        String pkg = posted.getPackageName() == null ? "" : posted.getPackageName();
        String source = sourceOf(pkg);
        if (source == null) {
            Log.i(TAG, when + "通知 " + pkg);
            return;
        }
        try {
            String raw = PaymentTexts.from(posted.getNotification());
            Log.i(TAG, "收到 " + source + " 通知：" + clip(raw));
            if (raw.trim().isEmpty()) {
                PaymentLauncher.remember(this, source, "（没有正文）");
                return;
            }
            PendingIntent openBill = posted.getNotification().contentIntent;
            if (openBill != null && (raw.contains("交易") || raw.contains("支付") || raw.contains("付款"))) {
                lastBill = openBill;
            }
            PaymentParser.Notice notice = PaymentParser.parse(source, raw);
            if (notice == null) {
                Log.i(TAG, "不是付款通知");
                PaymentLauncher.remember(this, source, raw);
                if (!"已有".equals(when) && (raw.contains("付款") || raw.contains("支付") || raw.contains("交易"))) {
                    PaymentAccessibilityService.awaitPage();
                }
                return;
            }
            Log.i(TAG, "解析到金额 " + notice.amount + " 商家 " + notice.merchant);
            if (openBill != null) lastBill = openBill;
            if ("已有".equals(when)) {
                Log.i(TAG, "这是启动时已在的通知，不拉起页面");
                PaymentLauncher.remember(this, source, raw);
                return;
            }
            PaymentAccessibilityService.awaitPage();
            PaymentLauncher.open(this, notice, raw);
        } catch (Throwable error) {
            Log.e(TAG, "读取通知失败", error);
            PaymentLauncher.remember(this, source, "读取失败");
        }
    }

    /** 打开这笔付款通知自己的页面。必须带上前台页面，否则系统会取消别人创建的跳转。 */
    static boolean openLastBill(Context context) {
        PendingIntent intent = newestBill();
        if (intent == null) {
            Log.i(TAG, "没有可打开的付款通知");
            return false;
        }
        try {
            if (context != null && Build.VERSION.SDK_INT >= 34) {
                ActivityOptions options = ActivityOptions.makeBasic();
                options.setPendingIntentBackgroundActivityStartMode(
                        ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                intent.send(context, 0, null, null, null, null, options.toBundle());
            } else if (context != null) {
                intent.send(context, 0, null, null, null, null, (Bundle) null);
            } else {
                intent.send();
            }
            Log.i(TAG, "已打开这笔付款通知");
            return true;
        } catch (PendingIntent.CanceledException error) {
            lastBill = null;
            Log.i(TAG, "这笔通知打不开，改直接打开应用");
            return false;
        }
    }

    /** 用通知栏里还在的那一条，不用刚才缓存的、可能已经失效的跳转。 */
    private static PendingIntent newestBill() {
        PaymentNotifyListener service = current == null ? null : current.get();
        if (service == null) return lastBill;
        StatusBarNotification[] active;
        try {
            active = service.getActiveNotifications();
        } catch (RuntimeException error) {
            return lastBill;
        }
        if (active == null) return lastBill;
        StatusBarNotification newest = null;
        for (StatusBarNotification posted : active) {
            if (posted == null || sourceOf(posted.getPackageName()) == null) continue;
            Notification notice = posted.getNotification();
            if (notice == null || notice.contentIntent == null) continue;
            String raw = PaymentTexts.from(notice);
            if (!raw.contains("交易") && !raw.contains("支付") && !raw.contains("付款")) continue;
            if (newest == null || posted.getPostTime() >= newest.getPostTime()) newest = posted;
        }
        if (newest != null) lastBill = newest.getNotification().contentIntent;
        return lastBill;
    }

    private static String clip(String raw) {
        String text = raw == null ? "" : raw.replace('\n', ' ').trim();
        if (text.length() > 160) return text.substring(0, 160);
        return text;
    }

    private static String sourceOf(String pkg) {
        if (WECHAT.equals(pkg)) return "wechat";
        if (ALIPAY.equals(pkg)) return "alipay";
        return null;
    }
}

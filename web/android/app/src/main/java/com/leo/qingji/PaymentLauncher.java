package com.leo.qingji;

import android.Manifest;
import android.app.ActivityOptions;
import android.app.AppOpsManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import java.lang.reflect.Method;

/** 认出付款后拉起记一笔。同一笔 20 秒内不重复打开。原文留给设置页查看。 */
final class PaymentLauncher {
    private static final String PREFS = "qingji.pay";
    /** 换过渠道 id：旧渠道如果被系统降成静音，悬浮通知就不会再响。 */
    private static final String CHANNEL = "pay-alert";
    private static String lastKey = "";
    private static long lastAt = 0;
    private static Intent lastIntent;

    private PaymentLauncher() {}

    static void remember(Context context, String source, String raw) {
        String text = raw == null ? "" : raw.trim();
        if (text.isEmpty()) return;
        if (text.length() > 240) text = text.substring(0, 240);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString("source", source == null ? "" : source)
                .putString("raw", text)
                .putLong("at", System.currentTimeMillis())
                .apply();
    }

    static String lastRaw(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString("raw", "");
        if (raw == null || raw.isEmpty()) return "";
        String source = prefs.getString("source", "");
        String who = "alipay".equals(source) ? "支付宝" : "wechat".equals(source) ? "微信" : "通知";
        return who + "：" + raw.replace('\n', ' ');
    }

    private static boolean shown;

    /** 监听到新的支付成功通知：发记一笔，并立刻拉起记账页。 */
    static void open(Context context, PaymentParser.Notice notice, String raw) {
        if (open(context, notice, raw, true)) show(context);
    }

    private static void show(Context context) {
        PixelOverlay.show(context);
        if (!PaymentAccessibilityService.bring(lastIntent)) cover(context, lastIntent);
        shown = true;
    }

    /** @return 这一笔是新的，调用方可以把它拉到前台 */
    static boolean open(Context context, PaymentParser.Notice notice, String raw, boolean notify) {
        remember(context, notice.source, raw);
        String key = notice.source + "|" + notice.amount + "|" + notice.merchant + "|" + notice.orderNo;
        long now = SystemClock.elapsedRealtime();
        if (key.equals(lastKey) && now - lastAt < 20000) {
            Log.i("QingjiPay", "20 秒内重复，只保留记一笔通知");
            if (notify && lastIntent != null) postFallback(context, notice, pending(context, alertFor(context, lastIntent)));
            return false;
        }
        lastKey = key;
        lastAt = now;
        shown = false;

        Uri uri = new Uri.Builder()
                .scheme("qingji")
                .authority("bill")
                .appendQueryParameter("id", String.valueOf(System.currentTimeMillis()))
                .appendQueryParameter("amount", notice.amount)
                .appendQueryParameter("payee", notice.merchant)
                .appendQueryParameter("note", notice.note)
                .appendQueryParameter("occurredAt", notice.occurredAt)
                .appendQueryParameter("type", notice.income ? "income" : "expense")
                .appendQueryParameter("source", notice.source)
                .build();
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.setClass(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        lastIntent = intent;
        logPopup(context);
        if (notify) postFallback(context, notice, pending(context, alertFor(context, intent)));
        return true;
    }

    /** 通知点击要新开一页。直接打开已在后台的记账页，小米不会把它带到前面。 */
    private static Intent alertFor(Context context, Intent bill) {
        Intent alert = new Intent(context, PayAlertActivity.class);
        alert.putExtra(PayAlertActivity.EXTRA_BILL, bill);
        alert.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_MULTIPLE_TASK
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        return alert;
    }

    /** 用户点了去微信/去支付宝，或刚看到支付成功页，再回到记账页。同一笔不反复拉起。 */
    static void comeBack(Context context, PaymentParser.Notice notice, String raw) {
        boolean fresh = open(context, notice, raw, false);
        if (fresh || !shown) show(context);
    }

    /** 新开一页盖住当前应用，再由那一页把记账页带上来。 */
    static void cover(Context context, Intent bill) {
        if (bill == null) return;
        Intent alert = new Intent(context, PayAlertActivity.class);
        alert.putExtra(PayAlertActivity.EXTRA_BILL, bill);
        alert.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_MULTIPLE_TASK
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        try {
            context.startActivity(alert);
            Log.i("QingjiPay", "已新开一页拉起记账");
        } catch (RuntimeException error) {
            Log.e("QingjiPay", "新开页面失败", error);
        }
    }

    /** 创建 PendingIntent 时只能声明创建方允许后台拉起。发送方参数放在 send() 里。 */
    private static Bundle creatorOptions() {
        if (Build.VERSION.SDK_INT < 34) return null;
        ActivityOptions options = ActivityOptions.makeBasic();
        options.setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
        return options.toBundle();
    }

    private static PendingIntent pending(Context context, Intent intent) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Bundle options = creatorOptions();
        if (Build.VERSION.SDK_INT >= 34 && options != null) {
            try {
                return PendingIntent.getActivity(context, 42, intent, flags, options);
            } catch (RuntimeException error) {
                Log.e("QingjiPay", "带后台拉起参数创建 PendingIntent 失败，改用普通参数", error);
            }
        }
        return PendingIntent.getActivity(context, 42, intent, flags);
    }

    private static void logPopup(Context context) {
        boolean notifications = Build.VERSION.SDK_INT < 33
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        Log.i("QingjiPay", notifications ? "通知权限已授予" : "通知权限未授予");
        try {
            AppOpsManager ops = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (ops == null) return;
            Method method = AppOpsManager.class.getMethod("checkOpNoThrow", int.class, int.class, String.class);
            int uid = Process.myUid();
            String pkg = context.getPackageName();
            int popup = (Integer) method.invoke(ops, 10021, uid, pkg);
            Log.i("QingjiPay", "后台弹出检查 " + popup);
        } catch (Throwable error) {
            Log.i("QingjiPay", "后台弹出检查失败 " + error.getClass().getSimpleName());
        }
    }

    private static void postFallback(Context context, PaymentParser.Notice notice, PendingIntent pending) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 34) {
            Log.i("QingjiPay", manager.canUseFullScreenIntent() ? "全屏意图可用" : "全屏意图未授权");
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "付款记一笔", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("付款后在微信上方弹出记一笔");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            channel.enableVibration(true);
            channel.enableLights(true);
            channel.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            manager.createNotificationChannel(channel);
        }
        String who = "alipay".equals(notice.source) ? "支付宝" : "微信";
        String merchant = notice.merchant == null || notice.merchant.isEmpty() ? who : notice.merchant;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        try {
            Log.i("QingjiPay", "准备发出记一笔通知");
            manager.notify(42, builder
                    .setSmallIcon(android.R.drawable.stat_notify_more)
                    .setContentTitle("记一笔 " + notice.amount)
                    .setContentText(merchant + "，点此打开")
                    .setTicker("记一笔 " + notice.amount)
                    .setCategory(Notification.CATEGORY_ALARM)
                    .setPriority(Notification.PRIORITY_MAX)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setDefaults(Notification.DEFAULT_ALL)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(false)
                    .setContentIntent(pending)
                    .setFullScreenIntent(pending, true)
                    .build());
        } catch (RuntimeException error) {
            Log.e("QingjiPay", "发出记一笔通知失败", error);
        }
    }
}

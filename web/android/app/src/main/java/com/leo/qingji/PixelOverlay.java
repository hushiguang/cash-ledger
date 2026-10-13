package com.leo.qingji;

import android.content.Context;
import android.graphics.PixelFormat;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

/**
 * 退到后台后挂一个看不见的窗口。Android 14 起只拿悬浮窗权限不够，
 * 必须真有窗口在屏幕上，系统才允许随后把记账页拉到支付宝前面。
 */
final class PixelOverlay {
    private static View dot;
    private static WindowManager windowManager;

    private PixelOverlay() {}

    static void show(Context context) {
        if (dot != null) return;
        Context app = context.getApplicationContext();
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(app)) {
            android.util.Log.i("QingjiPay", "没有悬浮窗权限，一像素没挂上");
            return;
        }
        WindowManager manager = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
        if (manager == null) return;
        View view = new View(app);
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                1, 1, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.START | Gravity.TOP;
        lp.alpha = 0.01f;
        try {
            manager.addView(view, lp);
            dot = view;
            windowManager = manager;
            android.util.Log.i("QingjiPay", "后台一像素已挂上");
        } catch (RuntimeException error) {
            android.util.Log.e("QingjiPay", "一像素悬浮失败", error);
        }
    }

    static void hide() {
        if (dot == null || windowManager == null) return;
        try {
            windowManager.removeView(dot);
        } catch (RuntimeException ignored) {
        }
        dot = null;
        windowManager = null;
    }
}

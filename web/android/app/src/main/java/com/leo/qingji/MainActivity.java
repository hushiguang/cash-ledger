package com.leo.qingji;

import android.Manifest;
import android.app.ActivityManager;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static boolean askedOverlay;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(QingjiNativePlugin.class);
        super.onCreate(savedInstanceState);
        bringUp(getIntent());
        askOverlay();
        if (Build.VERSION.SDK_INT >= 24) {
            NotificationListenerService.requestRebind(new ComponentName(this, PaymentNotifyListener.class));
        }
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 41);
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bringUp(intent);
    }

    private final Runnable dismissLater = () -> {
        if (hasWindowFocus() && taskVisible()) dismissPayNotification();
    };

    private boolean taskVisible() {
        if (Build.VERSION.SDK_INT < 29) return true;
        try {
            ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
            if (manager == null) return false;
            for (ActivityManager.AppTask task : manager.getAppTasks()) {
                if (task.getTaskInfo().isVisible()) return true;
            }
        } catch (RuntimeException ignored) {
        }
        return false;
    }

    @Override
    public void onResume() {
        super.onResume();
        PixelOverlay.hide();
    }

    @Override
    public void onStop() {
        PixelOverlay.show(this);
        super.onStop();
    }

    private void askOverlay() {
        if (askedOverlay || Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this)) return;
        askedOverlay = true;
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(intent);
        } catch (RuntimeException ignored) {
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (getWindow() == null || getWindow().getDecorView() == null) return;
        getWindow().getDecorView().removeCallbacks(dismissLater);
        if (hasFocus) getWindow().getDecorView().postDelayed(dismissLater, 1200);
    }

    private void dismissPayNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(42);
    }

    private void bringUp(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        if (!"qingji".equals(intent.getData().getScheme())) return;
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
        try {
            ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
            if (manager == null) return;
            for (ActivityManager.AppTask task : manager.getAppTasks()) {
                task.moveToFront();
                break;
            }
        } catch (RuntimeException ignored) {
        }
    }
}

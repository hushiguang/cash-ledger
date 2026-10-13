package com.leo.qingji;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "QingjiNative")
public class QingjiNativePlugin extends Plugin {
    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        start(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        start(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void openPayApp(PluginCall call) {
        String source = call.getString("source", "wechat");
        String pkg = "alipay".equals(source) ? "com.eg.android.AlipayGphone" : "com.tencent.mm";
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null) {
            call.reject("alipay".equals(source) ? "没有找到支付宝" : "没有找到微信");
            return;
        }
        PaymentAccessibilityService.watchDetail();
        android.content.Context foreground = getActivity() != null ? getActivity() : getContext();
        if (!PaymentNotifyListener.openLastBill(foreground)) start(launch);
        call.resolve();
    }

    @PluginMethod
    public void openPopupSettings(PluginCall call) {
        String pkg = getContext().getPackageName();
        Intent[] candidates = new Intent[] {
                miui("com.miui.permcenter.permissions.PermissionsEditorActivity", pkg),
                miui("com.miui.permcenter.permissions.AppPermissionsEditorActivity", pkg)
        };
        for (Intent intent : candidates) {
            try {
                start(intent);
                call.resolve();
                return;
            } catch (RuntimeException ignored) {
                // 换下一个小米权限页
            }
        }
        Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        details.setData(Uri.fromParts("package", pkg, null));
        start(details);
        call.resolve();
    }

    private static Intent miui(String cls, String pkg) {
        Intent intent = new Intent("miui.intent.action.APP_PERM_EDITOR");
        intent.setClassName("com.miui.securitycenter", cls);
        intent.putExtra("extra_pkgname", pkg);
        return intent;
    }

    @PluginMethod
    public void lastNotice(PluginCall call) {
        JSObject data = new JSObject();
        data.put("text", PaymentLauncher.lastRaw(getContext()));
        call.resolve(data);
    }

    private void start(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }
}

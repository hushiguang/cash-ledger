package com.leo.qingji;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

/**
 * 付款后先新开这一页。直接把已在后台的 MainActivity 往前拉时，
 * 小米只把账单数据塞进后台页面（结果码 3），记账页不会出现在微信前面。
 */
public class PayAlertActivity extends Activity {
    static final String EXTRA_BILL = "bill";

    private boolean forwarded;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (forwarded) return;
        forwarded = true;
        Intent bill = readBill();
        if (bill != null) {
            bill.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(bill);
        }
        finish();
    }

    private Intent readBill() {
        Intent incoming = getIntent();
        if (incoming == null) return null;
        if (Build.VERSION.SDK_INT >= 33) {
            return incoming.getParcelableExtra(EXTRA_BILL, Intent.class);
        }
        return incoming.getParcelableExtra(EXTRA_BILL);
    }
}

package com.leo.qingji;

import android.app.Notification;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.widget.RemoteViews;

import java.lang.reflect.Field;
import java.util.List;

/** 把一条通知里能读到的标题、正文、大文本和自定义布局拼成一段原文。 */
final class PaymentTexts {
    private PaymentTexts() {}

    static String from(Notification notification) {
        StringBuilder text = new StringBuilder();
        if (notification == null) return "";
        append(text, notification.tickerText);
        appendExtras(text, notification.extras);
        appendRemote(text, notification.contentView);
        appendRemote(text, notification.bigContentView);
        if (Build.VERSION.SDK_INT >= 31) appendRemote(text, notification.headsUpContentView);
        return text.toString();
    }

    private static void appendExtras(StringBuilder text, Bundle extras) {
        if (extras == null) return;
        String[] keys = new String[] {
                Notification.EXTRA_TITLE,
                Notification.EXTRA_TITLE_BIG,
                Notification.EXTRA_TEXT,
                Notification.EXTRA_BIG_TEXT,
                Notification.EXTRA_SUB_TEXT,
                Notification.EXTRA_SUMMARY_TEXT,
                Notification.EXTRA_INFO_TEXT,
                Notification.EXTRA_CONVERSATION_TITLE
        };
        for (String key : keys) {
            try {
                append(text, extras.getCharSequence(key));
            } catch (RuntimeException ignored) {
                // 微信的自定义字段解包失败时，保留已经读到的标题和正文
            }
        }
        try {
            CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null) {
                for (CharSequence line : lines) append(text, line);
            }
        } catch (RuntimeException ignored) {
        }
        try {
            Parcelable[] messages = Build.VERSION.SDK_INT >= 33
                    ? extras.getParcelableArray(Notification.EXTRA_MESSAGES, Parcelable.class)
                    : extras.getParcelableArray(Notification.EXTRA_MESSAGES);
            if (messages != null) {
                for (Parcelable message : messages) {
                    if (message instanceof Bundle) append(text, ((Bundle) message).getCharSequence("text"));
                }
            }
        } catch (RuntimeException ignored) {
        }
        try {
            for (String key : extras.keySet()) {
                Object value = extras.get(key);
                if (value instanceof CharSequence) append(text, (CharSequence) value);
            }
        } catch (RuntimeException ignored) {
        }
    }

    private static void appendRemote(StringBuilder text, RemoteViews views) {
        if (views == null) return;
        try {
            Field actionsField = RemoteViews.class.getDeclaredField("mActions");
            actionsField.setAccessible(true);
            Object raw = actionsField.get(views);
            if (!(raw instanceof List)) return;
            for (Object action : (List<?>) raw) {
                if (action == null) continue;
                for (Field field : action.getClass().getDeclaredFields()) {
                    field.setAccessible(true);
                    Object value = field.get(action);
                    if (value instanceof CharSequence) append(text, (CharSequence) value);
                }
            }
        } catch (Throwable ignored) {
            // 自定义布局读不到时，仍使用 extras 里的正文
        }
    }

    static void append(StringBuilder text, CharSequence part) {
        if (part == null) return;
        String value = part.toString().trim();
        if (value.isEmpty()) return;
        if (text.indexOf(value) >= 0) return;
        if (text.length() > 0) text.append('\n');
        text.append(value);
    }
}

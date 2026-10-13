package com.leo.qingji;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 从微信 / 支付宝通知原文里抽出金额和商家。
 * 只认带付款字样的通知，普通聊天里随口提到的金额不算。
 */
final class PaymentParser {
    static final class Notice {
        final String amount;
        final String merchant;
        final boolean income;
        final String source;
        final String note;
        final String occurredAt;
        final String orderNo;

        Notice(String amount, String merchant, boolean income, String source, String note, String occurredAt, String orderNo) {
            this.amount = amount;
            this.merchant = merchant;
            this.income = income;
            this.source = source;
            this.note = note == null ? "" : note;
            this.occurredAt = occurredAt == null ? "" : occurredAt;
            this.orderNo = orderNo == null ? "" : orderNo;
        }
    }

    private static final Pattern PREFERRED_AMOUNT = Pattern.compile(
            "(?:实付|付款金额|支付金额|收款金额|金额)[:：]?\\s*(?:¥|￥)?\\s*(\\d+(?:\\.\\d{1,2})?)");
    private static final Pattern AMOUNT = Pattern.compile(
            "(?:¥|￥)\\s*(\\d+(?:\\.\\d{1,2})?)|(\\d+(?:\\.\\d{1,2})?)\\s*元|(?:已支付|支付成功|付款成功|成功支付|成功付款|收款到账)\\s*(?:¥|￥)?\\s*(\\d+(?:\\.\\d{1,2})?)");
    private static final Pattern MERCHANT_LABELED = Pattern.compile(
            "(?:收款方全称|商户全称|商户名称|商家|收款方|付款给|收款人|商户)[:：\\s]+([^\\n，,。；;]{1,40})");
    private static final Pattern MERCHANT_QUOTED = Pattern.compile(
            "向[「\"“]([^」\"”]{1,30})[」\"”]");
    private static final Pattern MERCHANT_TO = Pattern.compile(
            "向([^\\s，,。；;\\n「」]{1,30}?)付款");
    private static final Pattern TITLE_PAYEE = Pattern.compile(
            "(?:扫二维码付款|二维码付款|转账|付款)[-－—]*给([^\\s\\n，,。]{1,20})");
    private static final Pattern SIGNED_AMOUNT = Pattern.compile(
            "(?:^|\\n)\\s*[+＋−–—-]?\\s*(\\d+\\.\\d{2})\\s*(?:\\n|$)");
    private static final Pattern CLOCK = Pattern.compile(
            "(\\d{4})年(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})");
    private static final Pattern DASH_CLOCK = Pattern.compile(
            "(\\d{4})-(\\d{1,2})-(\\d{1,2})\\s+(\\d{1,2}):(\\d{2})");
    /** 微信账单卡片：上一行是商家，接着「使用零钱支付」「¥70.10」「账单详情」。 */
    /** 中间这一行才是账户：使用「零钱」支付、使用「招商银行储蓄卡（5568）」支付。 */
    private static final Pattern USE_PAY = Pattern.compile("使用\\s*[「“\"']?(.{1,40}?)[」”\"']?\\s*支付");
    private static final Pattern YUAN = Pattern.compile("(?:¥|￥)\\s*(\\d+(?:\\.\\d{1,2})?)");
    private static final Pattern MONTH_DAY = Pattern.compile("(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})");
    private static final Pattern CLOCK_ONLY = Pattern.compile("^(\\d{1,2}):(\\d{2})$");

    private PaymentParser() {}

    static Notice parse(String source, String raw) {
        if (raw == null) return null;
        String text = raw.replace('\u00a0', ' ').replace('\u3000', ' ').trim();
        if (text.isEmpty() || !looksLikePayment(text)) return null;
        Notice alipay = alipayBill(source, text);
        if (alipay != null) return alipay;
        Notice success = alipaySuccess(source, text);
        if (success != null) return success;
        Notice feed = alipayFeed(source, text);
        if (feed != null) return feed;
        Notice card = billCard(source, text);
        if (card != null) return card;
        String amount = amount(text);
        if (amount == null) return null;
        boolean income = isIncome(text);
        String orderNo = orderNo(text);
        return new Notice(amount, merchant(text), income, source, note(text, orderNo), occurredAt(text), orderNo);
    }

    /**
     * 支付宝账单详情。大号金额可能是 -0.00（被支付遇财神抵掉），真正的金额在「订单金额」。
     * 标题下的名字是对方，收款方全称写进备注。
     */
    private static Notice alipayBill(String source, String text) {
        if (!text.contains("订单金额") && !text.contains("收款方全称")) return null;
        String amount = positiveAmount(field(text, "订单金额"));
        if (amount == null) return null;
        String fullName = valueAfter(text, "收款方全称");
        String payee = fullName.isEmpty() ? titleAboveSuccess(text) : fullName;
        StringBuilder note = new StringBuilder();
        appendNote(note, "支付方式", payMethod(text));
        appendNote(note, "商品说明", field(text, "商品说明"));
        appendNote(note, "支付遇财神", field(text, "支付遇财神"));
        String when = dashClock(field(text, "支付时间"));
        if (when.isEmpty()) when = dashClock(text);
        return new Notice(amount, payee, false, source, note.toString(), when, "");
    }

    /** 支付宝蓝底结果页：支付成功、大号金额、对方、付款方式。金额和「支付成功」可能在同一行。 */
    private static Notice alipaySuccess(String source, String text) {
        int status = text.indexOf("支付成功");
        if (status < 0) return null;
        int methodAt = text.indexOf("付款方式", status + "支付成功".length());
        if (methodAt < 0) return null;
        String between = text.substring(status + "支付成功".length(), methodAt);
        String amount = yuan(between);
        if (amount == null) return null;
        String payee = payeeIn(between);
        StringBuilder note = new StringBuilder();
        appendNote(note, "支付方式", payMethod(text.substring(methodAt)));
        return new Notice(amount, payee, false, source, note.toString(), "", "");
    }

    private static String payeeIn(String between) {
        for (String line : between.split("\\n")) {
            String trimmed = line.trim();
            if (isPayeeLine(trimmed)) return trimmed;
            for (String token : trimmed.split("\\s+")) {
                if (isPayeeLine(token)) return token;
            }
        }
        return "";
    }

    private static boolean isPayeeLine(String line) {
        if (line.isEmpty() || line.length() > 40) return false;
        if (line.equals("回首页") || line.equals("支付成功") || line.equals("完成") || line.equals("支付宝")) return false;
        if (line.startsWith("付款方式") || line.startsWith("¥") || line.startsWith("￥")) return false;
        if (yuan(line) != null) return false;
        if (line.contains("红包") || line.contains("体验金") || line.contains("优惠")) return false;
        return true;
    }

    /** 支付宝付款成功列表：最上面一条是刚付的。 */
    private static Notice alipayFeed(String source, String text) {
        if (text.contains("订单金额")) return null;
        if (!text.contains("付款方式")) return null;
        if (!text.contains("付款成功") && !text.contains("自动扣款成功")) return null;
        String[] lines = text.split("\\n");
        int status = -1;
        for (int i = 0; i < lines.length; i++) {
            if (isPayStatus(lines[i].trim())) {
                status = i;
                break;
            }
        }
        if (status < 0) return null;
        int end = lines.length;
        for (int i = status + 1; i < lines.length; i++) {
            if (isPayStatus(lines[i].trim())) {
                end = i;
                break;
            }
        }
        String amount = null;
        StringBuilder block = new StringBuilder();
        for (int i = status; i < end; i++) {
            if (block.length() > 0) block.append('\n');
            block.append(lines[i].trim());
            if (amount == null) amount = yuan(lines[i]);
        }
        if (amount == null) return null;
        String slice = block.toString();
        String counterparty = field(slice, "交易对象");
        String payee = counterparty != null && !counterparty.isEmpty() ? counterparty.trim() : nameAbove(lines, status);
        StringBuilder note = new StringBuilder();
        appendNote(note, "支付方式", payMethod(slice));
        appendNote(note, "扣款服务", field(slice, "扣款服务"));
        return new Notice(amount, payee, false, source, note.toString(), timeAbove(lines, status), "");
    }

    private static boolean isPayStatus(String line) {
        return line.contains("付款成功") || line.contains("自动扣款成功");
    }

    private static String nameAbove(String[] lines, int status) {
        for (int j = status - 1; j >= 0 && j >= status - 5; j--) {
            String prev = lines[j].trim();
            if (prev.isEmpty() || prev.contains("查看详情")) continue;
            if (!monthDay(prev).isEmpty() || !clockOnly(prev).isEmpty()) continue;
            if (prev.startsWith("¥") || prev.startsWith("￥")) continue;
            return prev;
        }
        return "";
    }

    private static String titleAboveSuccess(String text) {
        String[] lines = text.split("\\n");
        for (int i = 0; i < lines.length; i++) {
            if (!lines[i].trim().equals("交易成功")) continue;
            for (int j = i - 1; j >= 0 && j >= i - 4; j--) {
                String prev = lines[j].trim();
                if (prev.isEmpty() || prev.equals("账单详情") || prev.equals("全部账单")) continue;
                if (prev.matches("[+＋−–—-]?\\s*\\d+(?:\\.\\d{1,2})?")) continue;
                if (prev.length() > 40) continue;
                return prev;
            }
        }
        return "";
    }

    private static String positiveAmount(String value) {
        if (value == null) return null;
        Matcher matcher = Pattern.compile("(\\d+(?:\\.\\d{1,2})?)").matcher(value);
        if (!matcher.find()) return null;
        try {
            if (Double.parseDouble(matcher.group(1)) <= 0) return null;
        } catch (NumberFormatException ignored) {
            return null;
        }
        return matcher.group(1);
    }

    /** 「收款方全称 xxx」里的对方是 xxx，不是「全称」这两个字。 */
    private static String valueAfter(String text, String label) {
        String direct = field(text, label);
        if (usableName(direct)) return direct.trim();
        String[] lines = text.split("\\n");
        for (int i = 0; i < lines.length; i++) {
            String acc = lines[i].trim();
            if (acc.isEmpty() || !label.startsWith(acc)) continue;
            int k = i;
            while (acc.length() < label.length() && k + 1 < lines.length) {
                acc = acc + lines[++k].trim();
            }
            if (!acc.startsWith(label)) continue;
            String rest = acc.substring(label.length()).trim();
            if (usableName(rest)) return rest;
            if (k + 1 < lines.length && usableName(lines[k + 1].trim())) return lines[k + 1].trim();
        }
        return "";
    }

    private static boolean usableName(String name) {
        if (name == null) return false;
        String text = name.trim();
        if (text.isEmpty() || text.equals("全称") || text.equals("名称") || text.equals("收款方")) return false;
        return !text.equals("账单详情") && !text.equals("全部账单");
    }

    private static String cleanName(String value) {
        return usableName(value) ? value.trim() : "";
    }

    private static String dashClock(String text) {
        if (text == null || text.isEmpty()) return "";
        Matcher matcher = DASH_CLOCK.matcher(text);
        if (!matcher.find()) return "";
        return matcher.group(1) + "-" + pad(matcher.group(2)) + "-" + pad(matcher.group(3))
                + "T" + pad(matcher.group(4)) + ":" + matcher.group(5);
    }

    /** 微信支付页新的一笔在最下面。收款方优先于卡片标题。 */
    private static Notice billCard(String source, String text) {
        if (!text.contains("账单详情") || !text.contains("使用")) return null;
        String[] lines = text.split("\\n");
        Notice last = null;
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (!USE_PAY.matcher(line).find()) continue;
            Notice card = oneCard(source, lines, i, line);
            if (card != null) last = card;
        }
        return last;
    }

    private static Notice oneCard(String source, String[] lines, int index, String line) {
        String amount = yuan(line);
        String when = "";
        int end = Math.min(lines.length, index + 8);
        for (int j = index + 1; j < end; j++) {
            String next = lines[j].trim();
            if (USE_PAY.matcher(next).find()) {
                end = j;
                break;
            }
            if (amount == null) amount = yuan(next);
            if (when.isEmpty()) when = monthDay(next);
        }
        if (amount == null) return null;
        if (when.isEmpty()) when = timeAbove(lines, index);
        String merchant = payeeIn(lines, index, end);
        if (merchant.isEmpty()) merchant = merchantAbove(lines, index);
        String account = usePayAccount(line);
        if (account.isEmpty()) return null;
        return new Notice(amount, merchant, false, source, "支付方式：" + account, when, "");
    }

    /** 「零钱」「招商银行储蓄卡（5568）」取括号中间，全角括号改成和账户名一样的半角。 */
    private static String usePayAccount(String line) {
        Matcher matcher = USE_PAY.matcher(line);
        if (!matcher.find()) return "";
        return matcher.group(1).replace('（', '(').replace('）', ')').trim();
    }

    private static String payeeIn(String[] lines, int from, int end) {
        StringBuilder block = new StringBuilder();
        for (int i = from; i < end; i++) {
            if (block.length() > 0) block.append('\n');
            block.append(lines[i].trim());
        }
        String payee = field(block.toString(), "收款方");
        if (payee == null) payee = field(block.toString(), "商户全称");
        if (payee == null || skipBillLine(payee) || payee.contains("支付")) return "";
        return payee;
    }

    private static String merchantAbove(String[] lines, int index) {
        for (int j = index - 1; j >= 0 && j >= index - 4; j--) {
            String prev = lines[j].trim();
            if (USE_PAY.matcher(prev).find()) break;
            if (skipBillLine(prev)) continue;
            return prev;
        }
        return "";
    }

    private static String timeAbove(String[] lines, int index) {
        for (int j = index - 1; j >= 0 && j >= index - 6; j--) {
            String prev = lines[j].trim();
            if (USE_PAY.matcher(prev).find()) break;
            String dated = monthDay(prev);
            if (!dated.isEmpty()) return dated;
            String clock = clockOnly(prev);
            if (!clock.isEmpty()) return clock;
        }
        return "";
    }

    private static String clockOnly(String line) {
        Matcher matcher = CLOCK_ONLY.matcher(line.trim());
        if (!matcher.matches()) return "";
        int hour = Integer.parseInt(matcher.group(1));
        int minute = Integer.parseInt(matcher.group(2));
        if (hour > 23 || minute > 59) return "";
        java.util.Calendar now = java.util.Calendar.getInstance();
        return now.get(java.util.Calendar.YEAR) + "-"
                + pad(String.valueOf(now.get(java.util.Calendar.MONTH) + 1)) + "-"
                + pad(String.valueOf(now.get(java.util.Calendar.DAY_OF_MONTH)))
                + "T" + pad(String.valueOf(hour)) + ":" + pad(String.valueOf(minute));
    }

    private static String yuan(String line) {
        Matcher matcher = YUAN.matcher(line);
        if (!matcher.find()) return null;
        try {
            if (Double.parseDouble(matcher.group(1)) <= 0) return null;
        } catch (NumberFormatException ignored) {
            return null;
        }
        return matcher.group(1);
    }

    private static boolean skipBillLine(String line) {
        if (line.isEmpty() || line.length() <= 1) return true;
        if (line.contains("账单详情") || line.contains("使用")) return true;
        if (line.equals("微信支付凭证") || line.equals("支付凭证") || line.equals("微信支付")) return true;
        if (CLOCK_ONLY.matcher(line).matches()) return true;
        if (line.startsWith("¥") || line.startsWith("￥")) return true;
        if (MONTH_DAY.matcher(line).find()) return true;
        if (line.matches("[A-Za-z0-9 .]{1,12}")) return true;
        return line.equals("微信") || line.equals("支付宝");
    }

    private static String monthDay(String line) {
        Matcher matcher = MONTH_DAY.matcher(line);
        if (!matcher.find()) return "";
        int month = Integer.parseInt(matcher.group(1));
        int date = Integer.parseInt(matcher.group(2));
        int hour = Integer.parseInt(matcher.group(3));
        int minute = Integer.parseInt(matcher.group(4));
        java.util.Calendar now = java.util.Calendar.getInstance();
        int year = now.get(java.util.Calendar.YEAR);
        java.util.Calendar then = java.util.Calendar.getInstance();
        then.clear();
        then.set(year, month - 1, date, hour, minute, 0);
        if (then.after(now)) year -= 1;
        return year + "-" + pad(String.valueOf(month)) + "-" + pad(String.valueOf(date))
                + "T" + pad(String.valueOf(hour)) + ":" + pad(String.valueOf(minute));
    }

    private static boolean looksLikePayment(String text) {
        return text.contains("支付")
                || text.contains("付款")
                || text.contains("收款")
                || text.contains("支出")
                || text.contains("交易提醒")
                || text.contains("商户")
                || text.contains("商家");
    }

    private static boolean isIncome(String text) {
        boolean received = text.contains("收款") || text.contains("到账") || text.contains("收到");
        boolean paid = text.contains("付款") || text.contains("支出") || text.contains("已支付") || text.contains("支付成功");
        return received && !paid;
    }

    private static String amount(String text) {
        String found = firstGroup(PREFERRED_AMOUNT, text);
        if (found == null && (text.contains("支付成功") || text.contains("转账单号") || text.contains("当前状态"))) {
            found = firstGroup(SIGNED_AMOUNT, text);
        }
        if (found == null) found = firstGroup(AMOUNT, text);
        if (found == null) return null;
        try {
            if (Double.parseDouble(found) <= 0) return null;
        } catch (NumberFormatException ignored) {
            return null;
        }
        return found;
    }

    private static String merchant(String text) {
        String name = firstGroup(TITLE_PAYEE, text);
        if (name == null) name = firstGroup(MERCHANT_QUOTED, text);
        if (name == null) name = firstGroup(MERCHANT_TO, text);
        if (name == null || !usableName(name)) name = valueAfter(text, "收款方全称");
        if (!usableName(name)) name = firstGroup(MERCHANT_LABELED, text);
        if (name == null) return "";
        name = name.replaceAll("^[「\"“]+|[」\"”]+$", "").trim();
        if (name.isEmpty() || name.equals("你") || name.startsWith("你已") || name.startsWith("你向")) return "";
        if (name.equals("微信") || name.equals("支付宝") || name.equals("微信支付") || name.equals("支付宝支付")) return "";
        if (name.equals("全称") || name.equals("名称") || name.equals("收款方全称")) return "";
        if (name.equals("备注") || name.startsWith("备注") || name.equals("二维码收款") || name.equals("支付成功") || name.equals("零钱")) return "";
        return name;
    }

    private static String orderNo(String text) {
        String value = field(text, "转账单号");
        if (value == null) value = field(text, "交易单号");
        if (value == null) return "";
        return value.replaceAll("\\s+", "");
    }

    private static String occurredAt(String text) {
        String value = field(text, "转账时间");
        if (value == null) value = field(text, "支付时间");
        String source = value == null ? text : value;
        Matcher matcher = CLOCK.matcher(source);
        if (!matcher.find()) return "";
        return matcher.group(1) + "-" + pad(matcher.group(2)) + "-" + pad(matcher.group(3))
                + "T" + pad(matcher.group(4)) + ":" + matcher.group(5);
    }

    /** 支付宝写「付款方式」，微信写「支付方式」。记到同一行，页面才能对上账户。 */
    private static String payMethod(String text) {
        String method = field(text, "付款方式");
        if (method == null || method.isEmpty()) method = field(text, "支付方式");
        return method;
    }

    private static String note(String text, String orderNo) {
        StringBuilder note = new StringBuilder();
        appendNote(note, "支付方式", payMethod(text));
        appendNote(note, "转账单号", orderNo);
        appendNote(note, "收款方备注", field(text, "收款方备注"));
        return note.toString();
    }

    private static void appendNote(StringBuilder note, String label, String value) {
        if (value == null || value.isEmpty()) return;
        if (note.length() > 0) note.append('\n');
        note.append(label).append('：').append(value);
    }

    /** 标签单独一行时，值在下一行；同一行时取冒号或空格后面。单号被折行时把后面的数字拼上。 */
    private static String field(String text, String label) {
        String[] lines = text.split("\\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (!line.equals(label) && !line.startsWith(label)) continue;
            String rest = line.equals(label) ? "" : line.substring(label.length()).replaceFirst("^[:：\\s]+", "").trim();
            if (rest.isEmpty() && i + 1 < lines.length) rest = lines[i + 1].trim();
            if ((label.endsWith("单号")) && rest.matches("\\d+") && i + 2 < lines.length && lines[i + 2].trim().matches("\\d+")) {
                rest = rest + lines[i + 2].trim();
            }
            if (!rest.isEmpty()) return rest;
        }
        return null;
    }

    private static String pad(String value) {
        return value.length() == 1 ? "0" + value : value;
    }

    private static String firstGroup(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        if (!matcher.find()) return null;
        for (int i = 1; i <= matcher.groupCount(); i++) {
            String group = matcher.group(i);
            if (group != null && !group.isEmpty()) return group;
        }
        return null;
    }
}

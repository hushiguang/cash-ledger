/**
 * 领域模型。
 * 字段以 server/src 实际返回为准，拆页面时再逐步收紧成必填 / 精确联合类型。
 */

export type BillType = 'expense' | 'income' | 'transfer';
export type BookKind = 'personal' | 'trip' | 'family';
export type BookRole = 'owner' | 'member';

export interface User {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isActive?: boolean;
}

export interface Account {
  id: number;
  name: string;
  /** 现金 / 微信 / 支付宝 / 银行卡… */
  kind?: string;
  alias?: string | null;
  balance?: number;
  initial?: number;
  archived?: boolean;
  mergedInto?: number | null;
}

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  parentName?: string | null;
  kind: 'expense' | 'income';
  archived?: boolean;
  count?: number;
  amount?: number;
}

export interface BookMember {
  id: number;
  name: string;
  role?: BookRole;
}

export interface Book {
  id: number;
  name: string;
  kind: BookKind;
  kindLabel?: string;
  role: BookRole;
  archived?: boolean;
  shareEnabled?: boolean;
  shareToken?: string | null;
  /** 分享链接打开后能否补账。false 为只读 */
  shareWritable?: boolean;
  aaEnabled?: boolean;
  ownerName?: string;
  members?: BookMember[];
  participants?: BookMember[];
  billPeople?: BookMember[];
}

export interface Bill {
  id: number;
  bookId?: number;
  occurredAt: string;
  amount: number;
  type: BillType;
  categoryId?: number | null;
  categoryName?: string;
  categoryLabel?: string;
  subcategoryName?: string | null;
  accountId?: number | null;
  accountName?: string;
  toAccountId?: number | null;
  toAccountName?: string | null;
  note?: string | null;
  payee?: string | null;
  memberName?: string | null;
  shareWith?: string | null;
  images?: string[] | null;
  externalId?: string | null;
}

export interface RecurringBill {
  id: number;
  name?: string;
  amount: number;
  type: BillType;
  accountId?: number | null;
  accountName?: string;
  toAccountId?: number | null;
  categoryId?: number | null;
  categoryName?: string;
  note?: string | null;
  nextRun?: string;
  archived?: boolean;
}

/** 导入预览的一行（各平台字段不一致，未识别的放 raw） */
export interface ImportRow {
  occurredAt?: string;
  amount?: number;
  type?: BillType;
  accountName?: string;
  toAccountName?: string | null;
  categoryName?: string | null;
  categoryLabel?: string | null;
  subcategoryName?: string | null;
  note?: string | null;
  payee?: string | null;
  externalId?: string | null;
  skipReason?: string;
  selected?: boolean;
  [key: string]: unknown;
}

export interface ImportFile {
  filename: string;
  kind?: string;
  rows?: ImportRow[];
  error?: string;
}

export interface DuplicatePair {
  id?: number;
  a?: Bill;
  b?: Bill;
  diff?: string;
  reason?: string;
}

/** 后端统一响应外壳，具体接口再取里面的字段 */
export interface ApiEnvelope<T = unknown> {
  ok?: boolean;
  message?: string;
  [key: string]: unknown;
}

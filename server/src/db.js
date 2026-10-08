import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'ledger.db');
export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    initial_cents INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, kind, name)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    to_account_id INTEGER REFERENCES accounts(id),
    category_id INTEGER REFERENCES categories(id),
    occurred_at TEXT NOT NULL,
    payee TEXT,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,
    recurring_rule_id INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ux_tx_external
    ON transactions(user_id, source, external_id)
    WHERE external_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ix_tx_user_time ON transactions(user_id, occurred_at);
  -- 查重按「同用户 + 同类型 + 同金额」自连接，没有这个索引会退化成全表嵌套循环
  CREATE INDEX IF NOT EXISTS ix_tx_dup ON transactions(user_id, type, amount_cents, occurred_at);

  CREATE TABLE IF NOT EXISTS recurring_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    to_account_id INTEGER,
    category_id INTEGER,
    payee TEXT,
    note TEXT,
    frequency TEXT NOT NULL,
    interval_days INTEGER,
    weekdays TEXT,
    month_day INTEGER,
    year_month INTEGER,
    year_day INTEGER,
    start_date TEXT NOT NULL,
    end_date TEXT,
    time TEXT NOT NULL DEFAULT '09:00',
    next_run TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS import_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    filename TEXT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS import_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mapping TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS account_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE (user_id, alias)
  );

  CREATE TABLE IF NOT EXISTS category_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    alias TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    UNIQUE (user_id, kind, alias)
  );

  CREATE TABLE IF NOT EXISTS duplicate_ignores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pair_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, pair_key)
  );

  -- 账本：每个用户一个个人账本，另外可以有出游（共享）/家庭账本
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'personal',
    share_token TEXT UNIQUE,
    share_enabled INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (owner_id, name)
  );
  CREATE INDEX IF NOT EXISTS ix_books_owner ON books(owner_id);

  CREATE TABLE IF NOT EXISTS book_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL,
    UNIQUE (book_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS ix_book_members_user ON book_members(user_id);

  CREATE TABLE IF NOT EXISTS transaction_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_tx_images ON transaction_images(transaction_id);
`);

// accounts.merged_into：这个账户归属于哪个统一账户，为空表示自己就是统一账户。
const accountColumns = db.prepare('PRAGMA table_info(accounts)').all();
if (!accountColumns.some((c) => c.name === 'merged_into')) {
  db.exec('ALTER TABLE accounts ADD COLUMN merged_into INTEGER REFERENCES accounts(id)');
}

// 账本上线：transactions 需要 book_id / member_name / category_label，
// 同时共享账本允许不填账户，account_id 要改成可空 —— SQLite 改不了约束，只能重建表。
const txColumns = db.prepare('PRAGMA table_info(transactions)').all();
if (!txColumns.some((c) => c.name === 'book_id')) {
  rebuildTransactions();
}

function rebuildTransactions() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${dbPath}.bak-${stamp}`;
  try {
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  } catch {
    // 备份失败不阻断迁移，但尽量留下痕迹
    console.warn('账本迁移：备份失败，跳过备份');
  }
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE transactions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      account_id INTEGER REFERENCES accounts(id),
      to_account_id INTEGER REFERENCES accounts(id),
      category_id INTEGER REFERENCES categories(id),
      category_label TEXT,
      occurred_at TEXT NOT NULL,
      payee TEXT,
      note TEXT,
      member_name TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      recurring_rule_id INTEGER,
      created_at TEXT NOT NULL
    );
    INSERT INTO transactions_new (
      id, user_id, type, amount_cents, account_id, to_account_id, category_id,
      occurred_at, payee, note, source, external_id, recurring_rule_id, created_at
    ) SELECT
      id, user_id, type, amount_cents, account_id, to_account_id, category_id,
      occurred_at, payee, note, source, external_id, recurring_rule_id, created_at
    FROM transactions;
    DROP TABLE transactions;
    ALTER TABLE transactions_new RENAME TO transactions;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_tx_external
      ON transactions(user_id, source, external_id)
      WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_tx_user_time ON transactions(user_id, occurred_at);
    CREATE INDEX IF NOT EXISTS ix_tx_dup ON transactions(user_id, type, amount_cents, occurred_at);
    CREATE INDEX IF NOT EXISTS ix_tx_book ON transactions(book_id, occurred_at);
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}

// 每个用户都要有自己的个人账本，老账单归到个人账本里
const missingBooks = db.prepare(`
  SELECT u.id, u.display_name FROM users u
  WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.owner_id = u.id AND b.kind = 'personal')
`).all();
const insertBook = db.prepare(
  'INSERT INTO books (owner_id, name, kind, created_at) VALUES (?, ?, ?, ?)',
);
const insertMember = db.prepare(
  'INSERT OR IGNORE INTO book_members (book_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
);
for (const user of missingBooks) {
  const now = new Date().toISOString();
  const info = insertBook.run(user.id, '个人账本', 'personal', now);
  insertMember.run(Number(info.lastInsertRowid), user.id, 'owner', now);
}
db.prepare(`
  UPDATE transactions SET book_id = (
    SELECT id FROM books WHERE books.owner_id = transactions.user_id AND books.kind = 'personal'
  ) WHERE book_id IS NULL
`).run();

// 定期账单也归到某个账本：老规则统一归到各自的个人账本
const ruleColumns = db.prepare('PRAGMA table_info(recurring_rules)').all();
if (!ruleColumns.some((c) => c.name === 'book_id')) {
  db.exec('ALTER TABLE recurring_rules ADD COLUMN book_id INTEGER REFERENCES books(id) ON DELETE CASCADE');
}
db.prepare(`
  UPDATE recurring_rules SET book_id = (
    SELECT id FROM books WHERE books.owner_id = recurring_rules.user_id AND books.kind = 'personal'
  ) WHERE book_id IS NULL
`).run();

export function dataDirPath() {
  return dataDir;
}

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'expense.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  company TEXT,
  role TEXT NOT NULL DEFAULT 'applicant' CHECK (role IN ('applicant','supervisor','accounting','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  company TEXT,
  department TEXT,
  applicant_name TEXT,
  report_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','approved','accounting_checked','accounting_rejected','rejected')),
  total_amount INTEGER NOT NULL DEFAULT 0,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  checked_by INTEGER REFERENCES users(id),
  checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES expense_reports(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  item_date TEXT,
  site_name TEXT,
  payee TEXT,
  item_name TEXT,
  has_receipt TEXT CHECK (has_receipt IN ('有','無')),
  amount INTEGER NOT NULL DEFAULT 0,
  receipt_path TEXT,
  receipt_original_name TEXT
);
`);

// 既存DBへのマイグレーション

// expense_reports.status の CHECK 制約に accounting_rejected(経理差戻し)を追加する。
// SQLiteはCHECK制約を直接ALTERできないため、テーブルを作り直して移行する。
// expense_items から expense_reports への外部キー定義(テーブル名参照)を壊さないよう、
// 旧テーブルは rename ではなく drop し、新テーブルを最終的な名前へ rename する手順にする。
const reportsTableDef = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expense_reports'"
).get();
if (reportsTableDef && !reportsTableDef.sql.includes('accounting_rejected')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE expense_reports_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      company TEXT,
      department TEXT,
      applicant_name TEXT,
      report_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','approved','accounting_checked','accounting_rejected','rejected')),
      total_amount INTEGER NOT NULL DEFAULT 0,
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      checked_by INTEGER REFERENCES users(id),
      checked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO expense_reports_new SELECT * FROM expense_reports;
    DROP TABLE expense_reports;
    ALTER TABLE expense_reports_new RENAME TO expense_reports;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}

const itemColumns = db.prepare("PRAGMA table_info(expense_items)").all();
if (!itemColumns.some((c) => c.name === 'receipt_path')) {
  db.exec('ALTER TABLE expense_items ADD COLUMN receipt_path TEXT');
}
if (!itemColumns.some((c) => c.name === 'receipt_original_name')) {
  db.exec('ALTER TABLE expense_items ADD COLUMN receipt_original_name TEXT');
}

module.exports = db;

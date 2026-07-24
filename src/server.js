require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('./db');
const { requireLogin, requireRole } = require('./auth');
const { recognizeReceipt, recognizeReceiptFromPdf } = require('./ocr');

const app = express();
const PORT = process.env.PORT || 3000;

const COMPANIES = ['㈱ゆめすみか', '㈱吉村一建設', '㈱来夢エンジニア', '㈱ライトウェスト'];

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_RECEIPT_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_RECEIPT_TYPES.includes(file.mimetype)) {
      return cb(new Error('添付ファイルはPNG・JPEG・PDFのみ対応しています'));
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// OCR用: ディスクに保存せずメモリ上でTesseract/PDF解析に渡すだけなので memoryStorage を使う
const ocrUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/') && file.mimetype !== 'application/pdf') {
      return cb(new Error('画像ファイル(PNG/JPEG)またはPDFのみ読み取りに対応しています'));
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// 画像かPDFかを判定し、それぞれに応じた読み取り処理(OCR/テキスト抽出)を呼び分ける
function recognizeByMimeOrExt(buffer, { mimetype, filename }) {
  const isPdf = mimetype === 'application/pdf' || (filename && path.extname(filename).toLowerCase() === '.pdf');
  return isPdf ? recognizeReceiptFromPdf(buffer) : recognizeReceipt(buffer);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  store: new FileStore({ path: path.join(__dirname, '..', 'data', 'sessions') }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 },
}));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

// --- 認証 ---
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/reports');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'メールアドレスまたはパスワードが違います' });
  }
  req.session.user = { id: user.id, email: user.email, name: user.name, department: user.department, company: user.company, role: user.role };
  res.redirect(user.role === 'applicant' ? '/reports/new' : '/reports');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireLogin, (req, res) => res.redirect('/reports'));

// --- 精算表一覧 ---
app.get('/reports', requireLogin, (req, res) => {
  const reports = db.prepare(`
    SELECT * FROM expense_reports WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.session.user.id);
  res.render('reports_list', { reports });
});

// --- 明細行の保存(新規作成・再編集で共通) ---
const insertItem = db.prepare(`
  INSERT INTO expense_items (report_id, sort_order, item_date, site_name, payee, item_name, has_receipt, amount, receipt_path, receipt_original_name)
  VALUES (@report_id, @sort_order, @item_date, @site_name, @payee, @item_name, @has_receipt, @amount, @receipt_path, @receipt_original_name)
`);

// files: multer upload.any() の結果(req.files)。各行のファイル入力は receipt_file_<row_id> という名前で送信される。
// existingReceiptMap: 再編集時に、新しいファイルが添付されなかった行の既存ファイルを引き継ぐためのマップ(row_id -> { receipt_path, receipt_original_name })。
function saveItems(reportId, body, files = [], existingReceiptMap = {}) {
  const itemDates = [].concat(body.item_date || []);
  const itemSites = [].concat(body.site_name || []);
  const itemPayees = [].concat(body.payee || []);
  const itemNames = [].concat(body.item_name || []);
  const itemAmounts = [].concat(body.amount || []);
  const itemRowIds = [].concat(body.row_id || []);
  const itemRemoveReceipt = [].concat(body.remove_receipt || []);
  const itemReceipts = [].concat(body.has_receipt || []);

  let total = 0;
  for (let i = 0; i < itemDates.length; i++) {
    const amount = parseInt(itemAmounts[i], 10) || 0;
    if (!itemDates[i] && !itemSites[i] && !itemPayees[i] && !itemNames[i] && !amount) continue; // 空行はスキップ

    const rowId = itemRowIds[i] || `row${i}`;
    const uploadedFile = files.find((f) => f.fieldname === `receipt_file_${rowId}`);
    const existing = existingReceiptMap[rowId];
    // 「削除」ボタンで既存の添付ファイルを外した行は、新しいファイルが選び直されない限り既存ファイルを引き継がない
    const removed = itemRemoveReceipt[i] === '1';
    const receiptPath = uploadedFile ? uploadedFile.filename : (removed ? null : (existing ? existing.receipt_path : null));
    const receiptOriginalName = uploadedFile ? uploadedFile.originalname : (removed ? null : (existing ? existing.receipt_original_name : null));

    insertItem.run({
      report_id: reportId,
      sort_order: i,
      item_date: itemDates[i] || null,
      site_name: itemSites[i] || null,
      payee: itemPayees[i] || null,
      item_name: itemNames[i] || null,
      // 領収書有無: 添付ファイルが無ければ必ず「無」。添付がある場合は、インボイス登録番号(T+12桁)の
      // 読み取り結果に基づいてクライアント側が設定した値(有/無)を信頼する。
      has_receipt: receiptPath ? (itemReceipts[i] === '有' ? '有' : '無') : '無',
      amount,
      receipt_path: receiptPath,
      receipt_original_name: receiptOriginalName,
    });
    total += amount;
  }
  return total;
}

// 詳細/承認/経理確認画面で添付ファイルの種類(画像かPDFか)を判定するための付加情報を付ける
function annotateReceipts(items) {
  return items.map((it) => ({
    ...it,
    receipt_is_pdf: it.receipt_path ? path.extname(it.receipt_path).toLowerCase() === '.pdf' : false,
  }));
}

// --- 精算表 新規入力フォーム ---
app.get('/reports/new', requireLogin, (req, res) => {
  res.render('report_form', {
    mode: 'new',
    formAction: '/reports',
    user: req.session.user,
    report: null,
    items: [],
    companies: COMPANIES,
    today: new Date().toISOString().slice(0, 10),
  });
});

app.post('/reports', requireLogin, upload.any(), (req, res) => {
  const { report_date, company, department, applicant_name } = req.body;

  const insertReport = db.prepare(`
    INSERT INTO expense_reports (user_id, company, department, applicant_name, report_date, status, total_amount)
    VALUES (@user_id, @company, @department, @applicant_name, @report_date, 'submitted', 0)
  `);
  const updateTotal = db.prepare(`UPDATE expense_reports SET total_amount = ? WHERE id = ?`);

  db.exec('BEGIN');
  let reportId;
  try {
    const info = insertReport.run({
      user_id: req.session.user.id,
      company: company || req.session.user.company,
      department: department || req.session.user.department,
      applicant_name: applicant_name || req.session.user.name,
      report_date,
    });
    reportId = info.lastInsertRowid;
    const total = saveItems(reportId, req.body, req.files || []);
    updateTotal.run(total, reportId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.redirect(`/reports/${reportId}`);
});

// --- 精算表 詳細 ---
app.get('/reports/:id', requireLogin, (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!report) return res.status(404).send('見つかりません');
  const items = annotateReceipts(db.prepare('SELECT * FROM expense_items WHERE report_id = ? ORDER BY sort_order').all(report.id));
  res.render('report_detail', { report, items });
});

// --- 精算表 再編集(差戻しされた申請のみ) ---
app.get('/reports/:id/edit', requireLogin, (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!report) return res.status(404).send('見つかりません');
  if (report.status !== 'rejected') return res.status(400).send('編集できるのは差戻しされた申請のみです');
  const items = annotateReceipts(db.prepare('SELECT * FROM expense_items WHERE report_id = ? ORDER BY sort_order').all(report.id));
  res.render('report_form', {
    mode: 'edit',
    formAction: `/reports/${report.id}/edit`,
    user: req.session.user,
    report,
    items,
    companies: COMPANIES,
    today: report.report_date,
  });
});

app.post('/reports/:id/edit', requireLogin, upload.any(), (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!report) return res.status(404).send('見つかりません');
  if (report.status !== 'rejected') return res.status(400).send('編集できるのは差戻しされた申請のみです');

  const { report_date, company, department, applicant_name } = req.body;

  const existingReceiptMap = {};
  db.prepare('SELECT id, receipt_path, receipt_original_name FROM expense_items WHERE report_id = ?').all(report.id).forEach((it) => {
    existingReceiptMap[String(it.id)] = { receipt_path: it.receipt_path, receipt_original_name: it.receipt_original_name };
  });

  const updateReport = db.prepare(`
    UPDATE expense_reports
    SET company = @company, department = @department, applicant_name = @applicant_name, report_date = @report_date,
        status = 'submitted', total_amount = @total_amount, approved_by = NULL, approved_at = NULL, updated_at = datetime('now')
    WHERE id = @id
  `);
  const deleteItems = db.prepare('DELETE FROM expense_items WHERE report_id = ?');

  db.exec('BEGIN');
  try {
    deleteItems.run(report.id);
    const total = saveItems(report.id, req.body, req.files || [], existingReceiptMap);
    updateReport.run({
      company: company || report.company,
      department: department || report.department,
      applicant_name: applicant_name || report.applicant_name,
      report_date,
      total_amount: total,
      id: report.id,
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.redirect(`/reports/${report.id}`);
});

// --- 上長承認: 一覧 ---
// pending には「一般社員からの新規申請(submitted)」と「経理部門からの差戻し(accounting_rejected)」の両方を表示する
app.get('/approvals', requireRole('supervisor', 'admin'), (req, res) => {
  const pending = db.prepare(`
    SELECT * FROM expense_reports WHERE status IN ('submitted', 'accounting_rejected') ORDER BY created_at ASC
  `).all();
  const handled = db.prepare(`
    SELECT * FROM expense_reports
    WHERE status IN ('approved', 'rejected') AND approved_by = ?
    ORDER BY approved_at DESC LIMIT 20
  `).all(req.session.user.id);
  res.render('approvals_list', { pending, handled });
});

// --- 上長承認: 詳細 ---
app.get('/approvals/:id', requireRole('supervisor', 'admin'), (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('見つかりません');
  const items = annotateReceipts(db.prepare('SELECT * FROM expense_items WHERE report_id = ? ORDER BY sort_order').all(report.id));
  res.render('approval_detail', { report, items });
});

// --- 上長承認: 承認する ---
app.post('/approvals/:id/approve', requireRole('supervisor', 'admin'), (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('見つかりません');
  if (report.status !== 'submitted') return res.status(400).send('この申請は既に処理済みです');
  db.prepare(`
    UPDATE expense_reports SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(req.session.user.id, report.id);
  res.redirect('/approvals');
});

// --- 上長承認: 差戻す ---
app.post('/approvals/:id/reject', requireRole('supervisor', 'admin'), (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('見つかりません');
  if (report.status !== 'submitted') return res.status(400).send('この申請は既に処理済みです');
  db.prepare(`
    UPDATE expense_reports SET status = 'rejected', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(req.session.user.id, report.id);
  res.redirect('/approvals');
});

// --- 上長承認: 経理部門からの差戻しを確認し、一般社員へ差し戻す ---
// 承認ルート: 一般社員→上長承認→経理部門 / 差戻しルート: 経理部門→上長承認→一般社員
app.post('/approvals/:id/forward-to-applicant', requireRole('supervisor', 'admin'), (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('見つかりません');
  if (report.status !== 'accounting_rejected') return res.status(400).send('この申請は経理差戻しの対象ではありません');
  db.prepare(`
    UPDATE expense_reports SET status = 'rejected', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(req.session.user.id, report.id);
  res.redirect('/approvals');
});

// --- 領収書OCR: 画像/PDFから合計金額とインボイス登録番号(T+12桁)の有無を読み取る ---
app.post('/ocr/receipt', requireLogin, ocrUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルが指定されていません' });
  try {
    const { amount, hasInvoiceNumber } = await recognizeByMimeOrExt(req.file.buffer, {
      mimetype: req.file.mimetype,
      filename: req.file.originalname,
    });
    res.json({ amount, hasInvoiceNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '読み取りに失敗しました' });
  }
});

// 日付フィルタ用のクエリパラメータ(YYYY-MM-DD)を検証する。不正な値は無視する(undefinedを返す)。
function parseDateParam(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

// --- 経理確認: 一覧 ---
app.get('/accounting', requireRole('accounting', 'admin'), (req, res) => {
  const dateFrom = parseDateParam(req.query.date_from);
  const dateTo = parseDateParam(req.query.date_to);

  const pending = db.prepare(`
    SELECT * FROM expense_reports WHERE status = 'approved' ORDER BY approved_at ASC
  `).all();

  const handledConditions = ["status IN ('accounting_checked', 'accounting_rejected')", 'checked_by = ?'];
  const handledParams = [req.session.user.id];
  if (dateFrom) { handledConditions.push('report_date >= ?'); handledParams.push(dateFrom); }
  if (dateTo) { handledConditions.push('report_date <= ?'); handledParams.push(dateTo); }
  const handled = db.prepare(`
    SELECT * FROM expense_reports
    WHERE ${handledConditions.join(' AND ')}
    ORDER BY checked_at DESC ${dateFrom || dateTo ? '' : 'LIMIT 20'}
  `).all(...handledParams);

  res.render('accounting_list', { pending, handled, dateFrom, dateTo });
});

// --- 経理確認: 確認済みデータをCSVエクスポート ---
// CSVの1行 = 精算表の明細1行。添付ファイルは対象外。
// date_from/date_to(YYYY-MM-DD)を指定すると、精算表の日付でその範囲に絞り込む。
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

app.get('/accounting/export.csv', requireRole('accounting', 'admin'), (req, res) => {
  const dateFrom = parseDateParam(req.query.date_from);
  const dateTo = parseDateParam(req.query.date_to);

  const conditions = ["er.status = 'accounting_checked'"];
  const params = [];
  if (dateFrom) { conditions.push('er.report_date >= ?'); params.push(dateFrom); }
  if (dateTo) { conditions.push('er.report_date <= ?'); params.push(dateTo); }

  const rows = db.prepare(`
    SELECT
      er.applicant_name,
      er.department,
      ei.item_date,
      ei.site_name,
      ei.payee,
      ei.item_name,
      ei.amount
    FROM expense_items ei
    JOIN expense_reports er ON ei.report_id = er.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY er.report_date ASC, er.id ASC, ei.sort_order ASC
  `).all(...params);

  const header = ['社員名', '社員の部門名', '日付', '現場名', '支払先', '商品名', '税込金額'];
  const lines = [header.map(csvField).join(',')];
  for (const r of rows) {
    lines.push([
      r.applicant_name,
      r.department,
      r.item_date,
      r.site_name,
      r.payee,
      r.item_name,
      r.amount,
    ].map(csvField).join(','));
  }
  const BOM = '﻿';
  const csv = BOM + lines.join('\r\n') + '\r\n'; // Excelでの文字化け防止にBOMを付与

  const stamp = new Date().toISOString().slice(0, 10);
  const rangeSuffix = dateFrom || dateTo ? `_${dateFrom || 'start'}_${dateTo || 'end'}` : '';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="expense_checked${rangeSuffix}_${stamp}.csv"`);
  res.send(csv);
});

// --- 経理確認: 詳細 ---
app.get('/accounting/:id', requireRole('accounting', 'admin'), (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('見つかりません');
  const items = annotateReceipts(db.prepare('SELECT * FROM expense_items WHERE report_id = ? ORDER BY sort_order').all(report.id));
  res.render('accounting_detail', { report, items });
});

// --- 経理確認: 確認完了にする ---
app.post('/accounting/:id/check', requireRole('accounting', 'admin'), (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('見つかりません');
  if (report.status !== 'approved') return res.status(400).send('この申請は経理確認の対象ではありません');
  db.prepare(`
    UPDATE expense_reports SET status = 'accounting_checked', checked_by = ?, checked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(req.session.user.id, report.id);
  res.redirect('/accounting');
});

// --- 経理確認: 差戻す(上長の再承認を経て一般社員へ) ---
// 差戻しルート: 経理部門→上長(役職)承認→一般社員
app.post('/accounting/:id/reject', requireRole('accounting', 'admin'), (req, res) => {
  const report = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('見つかりません');
  if (report.status !== 'approved') return res.status(400).send('この申請は経理確認の対象ではありません');
  db.prepare(`
    UPDATE expense_reports SET status = 'accounting_rejected', checked_by = ?, checked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(req.session.user.id, report.id);
  res.redirect('/accounting');
});

// --- 添付ファイル(領収書画像・PDF)の閲覧 ---
app.get('/uploads/receipt/:itemId', requireLogin, (req, res) => {
  const row = db.prepare(`
    SELECT ei.receipt_path, er.user_id
    FROM expense_items ei
    JOIN expense_reports er ON ei.report_id = er.id
    WHERE ei.id = ?
  `).get(req.params.itemId);

  if (!row || !row.receipt_path) return res.status(404).send('ファイルが見つかりません');

  const isOwner = row.user_id === req.session.user.id;
  const isReviewer = ['supervisor', 'accounting', 'admin'].includes(req.session.user.role);
  if (!isOwner && !isReviewer) return res.status(403).send('アクセス権限がありません');

  res.sendFile(path.join(UPLOAD_DIR, row.receipt_path));
});

// --- 領収書OCR: 保存済みの添付ファイルから合計金額を読み取る(再編集時など) ---
app.post('/ocr/receipt/:itemId', requireLogin, async (req, res) => {
  const row = db.prepare(`
    SELECT ei.receipt_path, er.user_id
    FROM expense_items ei
    JOIN expense_reports er ON ei.report_id = er.id
    WHERE ei.id = ?
  `).get(req.params.itemId);

  if (!row || !row.receipt_path) return res.status(404).json({ error: 'ファイルが見つかりません' });

  const isOwner = row.user_id === req.session.user.id;
  const isReviewer = ['supervisor', 'accounting', 'admin'].includes(req.session.user.role);
  if (!isOwner && !isReviewer) return res.status(403).json({ error: 'アクセス権限がありません' });

  try {
    const buffer = fs.readFileSync(path.join(UPLOAD_DIR, row.receipt_path));
    const { amount, hasInvoiceNumber } = await recognizeByMimeOrExt(buffer, { filename: row.receipt_path });
    res.json({ amount, hasInvoiceNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '読み取りに失敗しました' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    console.error(err);
    return res.status(400).send(`エラー: ${err.message}`);
  }
  next();
});

app.listen(PORT, () => {
  console.log(`経費精算表システムが起動しました: http://localhost:${PORT}`);
});

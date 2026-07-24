const { createWorker } = require('tesseract.js');
const { PDFParse } = require('pdf-parse');

// 「合計」「TOTAL」等のキーワードが含まれる行を優先し、なければ本文中の最大の金額らしき数値を返す
function extractTotalAmount(text) {
  // OCRはカンマ区切り(1,234)をピリオド(1.234)と誤読することがあるため、両方を桁区切りとして扱う
  const numRegex = /[¥￥]?\s?([0-9][0-9,.]{2,})\s?円?/g;

  // インボイス登録番号(T+12桁)のような、明らかに金額ではない桁数の数値を除外する
  const PLAUSIBLE_MAX_AMOUNT = 10000000;

  function numbersInLine(line) {
    const matches = [...line.matchAll(numRegex)].map((m) => parseInt(m[1].replace(/[,.]/g, ''), 10));
    return matches.filter((n) => Number.isFinite(n) && n > 0 && n < PLAUSIBLE_MAX_AMOUNT);
  }

  const lines = text.split(/\r?\n/);
  const totalKeywords = ['合計', '総計', 'ご請求', 'お会計', 'total'];

  // 「合計」「総計」等が含まれる行を全て集め、その中の最大値を採用する
  // (小計・割引などの行にもキーワードが含まれ複数該当することがあるため、1行目で決め打ちにしない)
  const keywordNums = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (totalKeywords.some((kw) => line.includes(kw) || lower.includes(kw))) {
      keywordNums.push(...numbersInLine(line));
    }
  }
  if (keywordNums.length > 0) return Math.max(...keywordNums);

  const allNums = numbersInLine(text.replace(/\n/g, ' '));
  if (allNums.length > 0) return Math.max(...allNums);

  return null;
}

// インボイス制度の適格請求書発行事業者登録番号(T+数字13桁)が含まれているかを判定する。
// 領収書の「有・無」は、単にファイルが添付されているかではなく、この番号が読み取れるかどうかで判定する。
function hasInvoiceRegistrationNumber(text) {
  // OCR・PDF抽出テキストに全角数字が混じることがあるため、半角に正規化してから判定する
  const normalized = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  return /(?<!\d)T\d{12}(?!\d)/i.test(normalized);
}

async function recognizeReceipt(buffer) {
  const worker = await createWorker('jpn+eng');
  try {
    const { data } = await worker.recognize(buffer);
    return {
      text: data.text,
      amount: extractTotalAmount(data.text),
      hasInvoiceNumber: hasInvoiceRegistrationNumber(data.text),
    };
  } finally {
    await worker.terminate();
  }
}

// PDFはOCRではなく、埋め込まれたテキスト層から直接抽出する(スキャン画像だけのPDFはテキストが取れない場合がある)
async function recognizeReceiptFromPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return {
      text,
      amount: extractTotalAmount(text),
      hasInvoiceNumber: hasInvoiceRegistrationNumber(text),
    };
  } finally {
    await parser.destroy();
  }
}

module.exports = { recognizeReceipt, recognizeReceiptFromPdf, extractTotalAmount, hasInvoiceRegistrationNumber };

const { createWorker } = require('tesseract.js');
const { PDFParse } = require('pdf-parse');

// 「合計」「請求金額」「TOTAL」等のキーワードが含まれる行を優先し、その中でも
// 「￥」「円」が付いた金額らしい数値をさらに優先して採用する。
function extractTotalAmount(text) {
  // インボイス登録番号(T+12桁)のような、明らかに金額ではない桁数の数値を除外する
  const PLAUSIBLE_MAX_AMOUNT = 10000000;

  // OCRはカンマ区切り(1,234)をピリオド(1.234)と誤読することがあるため、両方を桁区切りとして扱う
  const numRegex = /[¥￥]?\s?([0-9][0-9,.]{2,})\s?円?/g;
  // 「￥1,000」「1,000円」のように、通貨記号がはっきり付いている数値だけを狙う(より信頼度が高い)
  const currencyNumRegex = /[¥￥]\s?([0-9][0-9,.]*)|([0-9][0-9,.]*)\s?円/g;

  function toPlausibleNumbers(rawValues) {
    return rawValues
      .map((v) => parseInt(v.replace(/[,.]/g, ''), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n < PLAUSIBLE_MAX_AMOUNT);
  }

  function numbersInLine(line) {
    return toPlausibleNumbers([...line.matchAll(numRegex)].map((m) => m[1]));
  }

  function currencyNumbersInLine(line) {
    return toPlausibleNumbers([...line.matchAll(currencyNumRegex)].map((m) => m[1] || m[2]));
  }

  const lines = text.split(/\r?\n/);
  const totalKeywords = ['合計', '総計', '請求金額', 'ご請求', '請求', 'お会計', 'total'];

  // 「合計」「請求金額」等が含まれる行を全て集める
  // (小計・割引などの行にもキーワードが含まれ複数該当することがあるため、1行目で決め打ちにしない)
  const keywordLines = lines.filter((line) => {
    const lower = line.toLowerCase();
    return totalKeywords.some((kw) => line.includes(kw) || lower.includes(kw));
  });

  if (keywordLines.length > 0) {
    // 優先1: キーワード行の中で「￥」「円」がはっきり付いている金額
    const currencyNums = keywordLines.flatMap(currencyNumbersInLine);
    if (currencyNums.length > 0) return Math.max(...currencyNums);

    // 優先2: 通貨記号は無いが、キーワード行内にある数値
    const plainNums = keywordLines.flatMap(numbersInLine);
    if (plainNums.length > 0) return Math.max(...plainNums);
  }

  // キーワードが見つからない場合は、本文全体から「￥」「円」付きの金額を優先して探す
  const wholeText = text.replace(/\n/g, ' ');
  const allCurrencyNums = currencyNumbersInLine(wholeText);
  if (allCurrencyNums.length > 0) return Math.max(...allCurrencyNums);

  const allNums = numbersInLine(wholeText);
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

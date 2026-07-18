const { createWorker } = require('tesseract.js');

// 「合計」「TOTAL」等のキーワードが含まれる行を優先し、なければ本文中の最大の金額らしき数値を返す
function extractTotalAmount(text) {
  // OCRはカンマ区切り(1,234)をピリオド(1.234)と誤読することがあるため、両方を桁区切りとして扱う
  const numRegex = /[¥￥]?\s?([0-9][0-9,.]{2,})\s?円?/g;

  function numbersInLine(line) {
    const matches = [...line.matchAll(numRegex)].map((m) => parseInt(m[1].replace(/[,.]/g, ''), 10));
    return matches.filter((n) => Number.isFinite(n));
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

async function recognizeReceipt(buffer) {
  const worker = await createWorker('jpn+eng');
  try {
    const { data } = await worker.recognize(buffer);
    return { text: data.text, amount: extractTotalAmount(data.text) };
  } finally {
    await worker.terminate();
  }
}

module.exports = { recognizeReceipt, extractTotalAmount };

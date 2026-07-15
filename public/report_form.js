(function () {
  const body = document.getElementById('items-body');
  const template = document.getElementById('row-template');
  const totalEl = document.getElementById('total-amount');

  function recalcTotal() {
    let total = 0;
    body.querySelectorAll('.amount-input').forEach((input) => {
      total += parseInt(input.value, 10) || 0;
    });
    totalEl.textContent = total.toLocaleString() + ' 円';
  }

  // 領収書の状態(有/無)とファイルの選択状況に応じて、ファイル選択ボタン/ファイル名表示/OCRボタンを切り替える
  function updateFileCell(row) {
    const select = row.querySelector('select[name="has_receipt"]');
    const fileInput = row.querySelector('input[type="file"]');
    const nameDisplay = row.querySelector('.file-name-display');
    const ocrBtn = row.querySelector('.ocr-btn');
    if (!select || !fileInput || !nameDisplay) return;

    const hasSelectedFile = fileInput.files && fileInput.files.length > 0;
    const hasName = nameDisplay.querySelector('.file-name-link').textContent.trim() !== '';

    if (hasSelectedFile || hasName) {
      fileInput.classList.add('is-hidden');
      nameDisplay.classList.remove('is-hidden');
    } else {
      fileInput.classList.remove('is-hidden');
      nameDisplay.classList.add('is-hidden');
    }

    if (ocrBtn) {
      const hasNewImage = hasSelectedFile && fileInput.files[0].type.startsWith('image/');
      const hasExistingImage = !hasSelectedFile && ocrBtn.dataset.existingItemId;
      ocrBtn.classList.toggle('is-hidden', !(hasNewImage || hasExistingImage));
    }
  }

  let newRowCounter = 0;

  function addRow() {
    const row = template.content.cloneNode(true);
    const uid = `new${newRowCounter++}`;
    const rowIdInput = row.querySelector('input[name="row_id"]');
    if (rowIdInput) rowIdInput.value = uid;
    const fileInput = row.querySelector('input[type="file"]');
    if (fileInput) fileInput.name = `receipt_file_${uid}`;
    body.appendChild(row);
    updateFileCell(body.lastElementChild);
    recalcTotal();
  }

  body.addEventListener('input', (e) => {
    if (e.target.classList.contains('amount-input')) recalcTotal();
  });

  body.addEventListener('change', (e) => {
    const row = e.target.closest('tr');
    if (!row) return;

    if (e.target.matches('select[name="has_receipt"]')) {
      updateFileCell(row);
    }

    if (e.target.matches('input[type="file"]') && e.target.files && e.target.files.length > 0) {
      const select = row.querySelector('select[name="has_receipt"]');
      const nameLink = row.querySelector('.file-name-link');
      const file = e.target.files[0];
      if (nameLink) {
        // 前に選択していたファイルのプレビュー用URLが残っていれば解放する
        if (nameLink.dataset.objectUrl) URL.revokeObjectURL(nameLink.dataset.objectUrl);
        const objectUrl = URL.createObjectURL(file);
        nameLink.dataset.objectUrl = objectUrl;
        nameLink.textContent = file.name;
        nameLink.setAttribute('href', objectUrl);
        nameLink.classList.add('receipt-link');
        nameLink.dataset.type = file.type === 'application/pdf' ? 'pdf' : 'image';
      }
      const ocrStatus = row.querySelector('.ocr-status');
      if (ocrStatus) ocrStatus.textContent = '';
      if (select) select.value = '有';
      const removeFlag = row.querySelector('.remove-receipt-flag');
      if (removeFlag) removeFlag.value = ''; // 新しいファイルを選び直したので削除フラグは解除
      updateFileCell(row);
    }
  });

  async function readAmountFromReceipt(row, ocrBtn) {
    const fileInput = row.querySelector('input[type="file"]');
    const amountInput = row.querySelector('.amount-input');
    const ocrStatus = row.querySelector('.ocr-status');
    const hasNewFile = fileInput.files && fileInput.files.length > 0;

    ocrBtn.disabled = true;
    if (ocrStatus) ocrStatus.textContent = '読み取り中...';

    try {
      let res;
      if (hasNewFile) {
        const formData = new FormData();
        formData.append('image', fileInput.files[0]);
        res = await fetch('/ocr/receipt', { method: 'POST', body: formData });
      } else {
        res = await fetch(`/ocr/receipt/${ocrBtn.dataset.existingItemId}`, { method: 'POST' });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '読み取りに失敗しました');

      if (data.amount) {
        amountInput.value = data.amount;
        recalcTotal();
        if (ocrStatus) ocrStatus.textContent = `読み取り結果: ${data.amount.toLocaleString()}円(内容をご確認ください)`;
      } else if (ocrStatus) {
        ocrStatus.textContent = '金額を検出できませんでした。手入力してください。';
      }
    } catch (err) {
      if (ocrStatus) ocrStatus.textContent = err.message || '読み取りに失敗しました';
    } finally {
      ocrBtn.disabled = false;
    }
  }

  body.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-row')) {
      e.target.closest('tr').remove();
      recalcTotal();
    }

    if (e.target.classList.contains('remove-file-btn')) {
      const row = e.target.closest('tr');
      const select = row.querySelector('select[name="has_receipt"]');
      const fileInput = row.querySelector('input[type="file"]');
      const nameDisplay = row.querySelector('.file-name-display');
      const nameLink = row.querySelector('.file-name-link');
      const ocrStatus = row.querySelector('.ocr-status');
      const ocrBtn = row.querySelector('.ocr-btn');
      if (fileInput) fileInput.value = '';
      if (nameLink) {
        if (nameLink.dataset.objectUrl) {
          URL.revokeObjectURL(nameLink.dataset.objectUrl);
          delete nameLink.dataset.objectUrl;
        }
        nameLink.textContent = '';
        nameLink.removeAttribute('href');
        nameLink.classList.remove('receipt-link');
      }
      if (nameDisplay) nameDisplay.classList.add('is-hidden');
      if (ocrStatus) ocrStatus.textContent = '';
      if (ocrBtn) delete ocrBtn.dataset.existingItemId;
      if (select) select.value = '無'; // 添付を削除したので領収書有無も自動的に「無」へ戻す
      const removeFlag = row.querySelector('.remove-receipt-flag');
      if (removeFlag) removeFlag.value = '1'; // サーバー側へ「既存の添付ファイルを削除する」ことを伝える
      if (fileInput) fileInput.classList.remove('is-hidden'); // ファイル欄を再表示し、必要なら自分で選び直せるようにする
      updateFileCell(row);
    }

    if (e.target.classList.contains('ocr-btn')) {
      const row = e.target.closest('tr');
      readAmountFromReceipt(row, e.target);
    }
  });

  document.getElementById('add-row').addEventListener('click', addRow);

  // 既存データがない場合(新規作成時)は5行分の空行を用意する
  if (body.children.length === 0) {
    for (let i = 0; i < 5; i++) addRow();
  } else {
    body.querySelectorAll('tr').forEach(updateFileCell);
    recalcTotal();
  }
})();

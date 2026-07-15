(function () {
  const modal = document.getElementById('receipt-modal');
  if (!modal) return;

  const body = document.getElementById('receipt-modal-body');
  const closeBtn = modal.querySelector('.modal-close');

  function openModal(url, isPdf) {
    body.innerHTML = '';
    if (isPdf) {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      body.appendChild(iframe);
    } else {
      const img = document.createElement('img');
      img.src = url;
      body.appendChild(img);
    }
    modal.classList.remove('is-hidden');
  }

  function closeModal() {
    modal.classList.add('is-hidden');
    body.innerHTML = '';
  }

  // イベント委譲にすることで、後から動的に追加・変更されるリンクにも対応する
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.receipt-link');
    if (!link || !link.getAttribute('href')) return;
    e.preventDefault();
    openModal(link.getAttribute('href'), link.dataset.type === 'pdf');
  });

  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
})();

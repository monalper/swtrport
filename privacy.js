(() => {
  const MASK = "********";
  const EYE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;

  let enabled = false;
  let syncing = false;
  let observer = null;
  let suppressObserver = false;

  function shouldIgnoreMutations(mutations) {
    for (const m of mutations) {
      const target = m?.target;
      if (!(target instanceof Node)) return false;

      const el =
        target instanceof Element ? target : target.parentElement instanceof Element ? target.parentElement : null;
      if (!el) return false;

      if (!el.closest('td[data-sensitive]')) return false;
    }
    return true;
  }

  function isSensitiveCell(cell) {
    return cell instanceof HTMLElement && cell.tagName === "TD" && cell.hasAttribute("data-sensitive");
  }

  function canMaskText(text) {
    const t = String(text ?? "").trim();
    return t !== "" && t !== "-";
  }

  function maskCell(cell) {
    if (!isSensitiveCell(cell)) return;
    if (cell.dataset.unmaskedHtml == null) cell.dataset.unmaskedHtml = cell.innerHTML;
    if (!canMaskText(cell.textContent)) return;
    cell.textContent = MASK;
  }

  function unmaskCell(cell) {
    if (!isSensitiveCell(cell)) return;
    if (cell.dataset.unmaskedHtml == null) return;
    cell.innerHTML = cell.dataset.unmaskedHtml;
    delete cell.dataset.unmaskedHtml;
  }

  function syncCells() {
    if (syncing) return;
    syncing = true;
    try {
      suppressObserver = true;
      const cells = document.querySelectorAll('td[data-sensitive]');
      for (const cell of cells) {
        if (enabled) maskCell(cell);
        else unmaskCell(cell);
      }
    } finally {
      syncing = false;
      setTimeout(() => {
        suppressObserver = false;
      }, 0);
    }
  }

  function ensureEyeButton() {
    const actions = document.getElementById("app-header-actions") ?? document.getElementById("main-tabs");
    if (!actions) return;

    let btn = document.getElementById("btn-mask-values");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "btn-mask-values";
      btn.className = "mainTabAction";
      btn.setAttribute("aria-label", "Tutar ve değerleri gizle");
      btn.title = "Tutar ve değerleri gizle";
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = EYE_ICON_SVG;
      btn.addEventListener("click", () => setEnabled(!enabled));
    }

    if (btn.parentElement !== actions) actions.appendChild(btn);

    const pdfBtn = document.getElementById("btn-export-pdf");
    if (pdfBtn && pdfBtn.parentElement === actions) {
      if (pdfBtn.nextElementSibling !== btn) actions.insertBefore(btn, pdfBtn.nextSibling);
    }

    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    ensureEyeButton();
    syncCells();
  }

  function initObserver() {
    if (observer) return;
    const root = document.getElementById("main-panels") ?? document.getElementById("main") ?? document.body;
    if (!root) return;
    observer = new MutationObserver((mutations) => {
      if (suppressObserver || syncing) return;
      if (shouldIgnoreMutations(mutations)) return;
      ensureEyeButton();
      if (enabled) syncCells();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function init() {
    ensureEyeButton();
    initObserver();
    syncCells();
  }

  window.SWPORT_PRIVACY = { setEnabled, sync: syncCells };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();

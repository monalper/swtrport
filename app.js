/* global window, document, FileReader */
const NA = "-";

const QUOTES_REFRESH_OK_MS = 10_000;
const QUOTES_REFRESH_ERROR_MS = 30_000;
const QUOTES_FETCH_TIMEOUT_MS = 8_000;

const STATE = {
  data: null,
  filtered: [],
  quotes: {},
  live: { state: "idle", lastUpdated: null, message: "", apiBase: "" },
  history: { start: null, end: null, series: {}, errors: {}, pending: null, tickersKey: "" },
  ui: {
    mainTab: "portfolios",
    wired: false,
    chartScheduled: false,
    lastChartPositions: null,
    lastLiveChangePctBySymbol: Object.create(null),
    quotesRefresh: { inFlight: false, timerId: null },
    chartPrefs: { metric: "pct", range: "ALL" },
    exportPdfInFlight: false,
  },
};

const el = {
  notice: document.getElementById("notice"),
  meta: document.getElementById("meta"),
  mainTabs: document.getElementById("main-tabs"),
  mainPanels: document.getElementById("main-panels"),
  heroCurrent: document.getElementById("hero-current"),
  heroActive: document.getElementById("hero-active"),
  heroDay: document.getElementById("hero-day"),
  liveGrid: document.getElementById("live-grid"),
  riskGrid: document.getElementById("risk-grid"),
  realizedGrid: document.getElementById("realized-grid"),
  detailedStatsGrid: document.getElementById("detailed-stats-grid"),
  traderVerdict: document.getElementById("trader-verdict"),
  tableOpen: document.getElementById("table-open"),
  tableLive: document.getElementById("table-live"),
  tableClosed: document.getElementById("table-closed"),
  countOpen: document.getElementById("count-open"),
  countClosed: document.getElementById("count-closed"),
  btnExportPdf: document.getElementById("btn-export-pdf"),
};

function escapeHTML(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getCurrency() {
  const cur = STATE.data?.currency;
  return typeof cur === "string" && cur.trim() ? cur.trim() : "TL";
}

function formatTL(amount) {
  if (amount == null || amount === "") return NA;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return NA;
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `${formatted} ${getCurrency()}`;
}

function formatPct(value) {
  if (value == null || value === "") return NA;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return NA;
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `${formatted}%`;
}

function formatSignedTL(amount) {
  if (amount == null || amount === "") return NA;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return NA;
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${formatTL(Math.abs(n))}`;
}

function formatSignedPct(value) {
  if (value == null || value === "") return NA;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return NA;
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${formatPct(Math.abs(n))}`;
}

function currencySymbolFor(cur) {
  const c = String(cur ?? "").trim().toUpperCase();
  if (c === "TL" || c === "TRY") return "₺";
  if (c === "USD") return "$";
  if (c === "EUR") return "€";
  return c || "₺";
}

function formatMoneyPartsTR(amount) {
  if (amount == null || amount === "") return null;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  const idx = formatted.lastIndexOf(",");
  const intPart = idx >= 0 ? formatted.slice(0, idx) : formatted;
  const fracPart = idx >= 0 ? formatted.slice(idx) : "";
  return { intPart, fracPart };
}

function formatMoneySymbolTR(amount, { signed } = {}) {
  if (amount == null || amount === "") return NA;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return NA;
  const sign = signed && n < 0 ? "-" : "";
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
  return `${sign}${currencySymbolFor(getCurrency())}${formatted}`;
}

function renderHero({ activeTL, currentTL, dayChangeTL, dayChangePct, hasLive } = {}) {
  if (el.heroCurrent) {
    const parts = formatMoneyPartsTR(currentTL);
    if (parts) {
      el.heroCurrent.innerHTML = `
        <span class="heroSymbol">${escapeHTML(currencySymbolFor(getCurrency()))}</span>
        <span class="heroInt">${escapeHTML(parts.intPart)}</span>
        <span class="heroFrac">${escapeHTML(parts.fracPart)}</span>
      `.trim();
    } else {
      el.heroCurrent.textContent = NA;
    }
  }

  if (el.heroActive) el.heroActive.textContent = formatMoneySymbolTR(activeTL);

  if (el.heroDay) {
    if (!hasLive) {
      el.heroDay.textContent = NA;
    } else {
      const cls = dayChangeTL > 0 ? "good" : dayChangeTL < 0 ? "bad" : "warn";
      const tl = formatMoneySymbolTR(dayChangeTL, { signed: true });
      const pctRaw = Number(dayChangePct);
      const pctAbs = Number.isFinite(pctRaw) ? formatPct(Math.abs(pctRaw)) : NA;
      const pct = pctRaw < 0 ? `-${pctAbs}` : pctAbs;
      el.heroDay.innerHTML = `<span class="heroDelta ${cls}">${escapeHTML(tl)}</span> <span class="heroDeltaPct">(${escapeHTML(pct)})</span>`;
    }
  }
}

function renderStatGrid(gridEl, items) {
  if (!gridEl) return;
  gridEl.innerHTML = Array.isArray(items) ? items.join("") : "";
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function signedClass(value, { nanClass = "warn" } = {}) {
  if (value == null || value === "") return nanClass;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return nanClass;
  if (Math.abs(n) < 1e-9) return "zero";
  if (n > 0) return "good";
  if (n < 0) return "bad";
  return "zero";
}

function parseISODate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTR(value) {
  const date = parseISODate(value);
  if (!date) return NA;
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function normalize(s) {
  return String(s ?? "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD");
}

function approxQuantity(total, unitCost) {
  const t = Number(total);
  const u = Number(unitCost);
  if (!Number.isFinite(t) || !Number.isFinite(u) || u === 0) return null;
  const q = t / u;
  const nearest = Math.round(q);
  if (Math.abs(q - nearest) < 1e-6) return nearest;
  return Math.round(q * 100) / 100;
}

const OUTCOME = {
  good: "Başarılı",
  warn: "Nötr",
  bad: "Başarısız",
};

function outcomeClass(label) {
  if (label === OUTCOME.good) return "good";
  if (label === OUTCOME.bad) return "bad";
  if (label === OUTCOME.warn) return "warn";
  return "";
}

function outcomeLabel(position) {
  const o = position?.outcome;

  if (o === 1 || o === "1") return OUTCOME.good;
  if (o === 0 || o === "0") return OUTCOME.bad;
  if (o === OUTCOME.good || o === OUTCOME.bad || o === OUTCOME.warn) return o;

  if (!position?.sellDate) return OUTCOME.warn;
  return NA;
}

function exitPriceFromOutcome(position) {
  const label = outcomeLabel(position);
  if (label === OUTCOME.good) {
    const raw = position?.takeProfit;
    if (raw == null || raw === "") return null;
    const tp = Number(raw);
    return Number.isFinite(tp) ? tp : null;
  }
  if (label === OUTCOME.bad) {
    const raw = position?.stopLoss;
    if (raw == null || raw === "") return null;
    const sl = Number(raw);
    return Number.isFinite(sl) ? sl : null;
  }
  return null;
}

function calcPnL(position, exitPrice) {
  const qty = approxQuantity(position?.total, position?.unitCost);
  const unitCost = Number(position?.unitCost);
  const total = Number(position?.total);
  const exitP = Number(exitPrice);

  if (qty == null || !Number.isFinite(unitCost) || !Number.isFinite(total) || !Number.isFinite(exitP)) {
    return { pnlTL: null, pnlPct: null, invested: Number.isFinite(total) ? total : null };
  }

  const pnlTL = qty * (exitP - unitCost);
  const pnlPct = unitCost !== 0 ? ((exitP / unitCost) - 1) * 100 : null;
  return { pnlTL, pnlPct, invested: total };
}

function calcRiskReward(position) {
  const qty = approxQuantity(position?.total, position?.unitCost);
  const unitCost = Number(position?.unitCost);
  const invested = Number(position?.total);
  const sl = Number(position?.stopLoss);
  const tp = Number(position?.takeProfit);

  if (
    qty == null ||
    !Number.isFinite(unitCost) ||
    !Number.isFinite(invested) ||
    !Number.isFinite(sl) ||
    !Number.isFinite(tp) ||
    unitCost === 0
  ) {
    return { invested: Number.isFinite(invested) ? invested : null, riskTL: null, rewardTL: null };
  }

  const riskTL = qty * Math.max(unitCost - sl, 0);
  const rewardTL = qty * Math.max(tp - unitCost, 0);
  return { invested, riskTL, rewardTL };
}

function statHTML(k, v, valueClass = "") {
  const cls = valueClass ? ` ${valueClass}` : "";
  return `<div class="stat"><span class="k">${escapeHTML(k)}</span><span class="v${cls}">${escapeHTML(
    v
  )}</span></div>`;
}

function setMainTab(nextTab) {
  const root = el.mainTabs;
  const panelsRoot = el.mainPanels;
  if (!root || !panelsRoot) return;

  const tabs = Array.from(root.querySelectorAll('button[role="tab"][data-tab]'));
  const panels = Array.from(panelsRoot.querySelectorAll('[role="tabpanel"][data-tabpanel]'));
  if (!tabs.length || !panels.length) return;

  const safeNext = tabs.some((t) => t.dataset.tab === nextTab) ? nextTab : tabs[0]?.dataset?.tab;
  if (!safeNext) return;
  STATE.ui.mainTab = safeNext;

  for (const tab of tabs) {
    const isActive = tab.dataset.tab === safeNext;
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
    tab.tabIndex = isActive ? 0 : -1;
  }

  for (const panel of panels) {
    const isActive = panel.dataset.tabpanel === safeNext;
    if (isActive) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  }

  syncMainTabIndicator();
  if (safeNext === "chart") scheduleChartUpdate(STATE.filtered || []);
}

function syncMainTabIndicator() {
  const root = el.mainTabs;
  if (!root) return;
  const indicator = root.querySelector(".mainTabIndicator");
  if (!indicator) return;

  const active = root.querySelector('button[role="tab"][data-tab][aria-selected="true"]');
  if (!(active instanceof HTMLElement)) return;

  const baseLeft = 6;
  indicator.style.width = `${Math.max(0, active.offsetWidth)}px`;
  indicator.style.transform = `translateX(${Math.max(0, active.offsetLeft - baseLeft)}px)`;
}

function summaryTabsHTML(groups) {
  const active = groups.some((g) => g.id === STATE.ui.summaryTab) ? STATE.ui.summaryTab : groups[0]?.id;
  const list = groups
    .map((g) => {
      const isActive = g.id === active;
      return `<button class="tab" type="button" role="tab" id="summary-tab-${escapeHTML(g.id)}" data-tab="${escapeHTML(
        g.id
      )}" aria-selected="${isActive ? "true" : "false"}" aria-controls="summary-panel-${escapeHTML(
        g.id
      )}" tabindex="${isActive ? "0" : "-1"}">${escapeHTML(g.label)}</button>`;
    })
    .join("");

  const panels = groups
    .map((g) => {
      const isActive = g.id === active;
      const content = g.contentHTML ? String(g.contentHTML) : `<div class="summaryGrid">${g.stats.join("")}</div>`;
      return `<div class="tabPanel" role="tabpanel" id="summary-panel-${escapeHTML(
        g.id
      )}" data-tabpanel="${escapeHTML(g.id)}" aria-labelledby="summary-tab-${escapeHTML(g.id)}"${
        isActive ? "" : " hidden"
      }>${content}</div>`;
    })
    .join("");

  return `<div class="tabs" role="tablist" aria-label="İstatistik sekmeleri">${list}</div>${panels}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function isDateKey(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
}

function tickersFromPositionsList(positions) {
  const set = new Set();
  for (const p of positions) {
    const sym = String(p?.symbol ?? "").trim();
    if (sym) set.add(sym.toUpperCase());
  }
  return Array.from(set);
}

function minBuyDateKey(positions) {
  let min = null;
  for (const p of positions) {
    const k = String(p?.buyDate ?? "").trim();
    if (!isDateKey(k)) continue;
    if (min == null || k < min) min = k;
  }
  return min;
}

function dateKeyFromUnixSeconds(sec) {
  const ms = Number(sec) * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function historyApiBases() {
  const proto = window.location?.protocol || "";
  const isHttp = proto === "http:" || proto === "https:";
  if (isHttp) return [""];

  return Array.from(
    new Set(
      [
        STATE.live?.apiBase || "",
        "",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
      ].filter((x) => typeof x === "string")
    )
  );
}

async function fetchJSONFromBases(pathWithQuery, { signal } = {}) {
  const bases = historyApiBases();
  let lastErr = null;
  for (const base of bases) {
    try {
      const prefix = base ? base.replace(/\/+$/, "") : "";
      const url = `${prefix}${pathWithQuery.startsWith("/") ? "" : "/"}${pathWithQuery}`;
      const res = await fetch(url, { cache: "no-store", signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Fetch basarisiz");
}

async function ensureHistory(tickers, { start, end, signal } = {}) {
  const startKey = isDateKey(start) ? start : null;
  const endKey = isDateKey(end) ? end : null;
  const tickersKey = tickers.slice().sort().join(",");

  const rangeOk =
    STATE.history.start &&
    STATE.history.end &&
    startKey &&
    endKey &&
    STATE.history.start <= startKey &&
    STATE.history.end >= endKey;

  const tickersOk = tickers.every((t) => STATE.history.series?.[t]);

  if (rangeOk && tickersOk) return;

  const qs = new URLSearchParams();
  qs.set("tickers", tickersKey);
  if (startKey) qs.set("start", startKey);
  if (endKey) qs.set("end", endKey);

  const json = await fetchJSONFromBases(`/api/history?${qs.toString()}`, { signal });
  STATE.history = {
    start: startKey,
    end: endKey,
    series: json?.series && typeof json.series === "object" ? json.series : {},
    errors: json?.errors && typeof json.errors === "object" ? json.errors : {},
    pending: null,
    tickersKey,
  };
}

function computeTWRSeries(positions, historySeries, { liveQuotes } = {}) {
  const unitFallback = {};
  for (const p of positions) {
    const t = String(p?.symbol ?? "").trim().toUpperCase();
    const unitCost = Number(p?.unitCost);
    if (t && Number.isFinite(unitCost) && unitFallback[t] == null) unitFallback[t] = unitCost;
  }

  const liveDayKey = liveQuotes ? todayKey() : null;

  const events = {};
  const ensureDay = (k) => {
    if (!events[k]) events[k] = { buys: [], sells: [] };
    return events[k];
  };

  for (const p of positions) {
    const ticker = String(p?.symbol ?? "").trim().toUpperCase();
    const buyDate = String(p?.buyDate ?? "").trim();
    if (!ticker || !isDateKey(buyDate)) continue;

    const qty = approxQuantity(p?.total, p?.unitCost);
    const cost = Number(p?.total);
    if (qty == null || !Number.isFinite(cost)) continue;

    ensureDay(buyDate).buys.push({ ticker, qty, cost });

    const sellDate = String(p?.sellDate ?? "").trim();
    if (isDateKey(sellDate)) {
      const exit = exitPriceFromOutcome(p);
      ensureDay(sellDate).sells.push({ ticker, qty, exitPrice: Number.isFinite(exit) ? exit : null });
    }
  }

  const dateSet = new Set();
  for (const k of Object.keys(events)) dateSet.add(k);
  dateSet.add(todayKey());

  for (const series of Object.values(historySeries || {})) {
    const timestamps = Array.isArray(series?.timestamps) ? series.timestamps : [];
    for (const ts of timestamps) {
      const k = dateKeyFromUnixSeconds(ts);
      if (k) dateSet.add(k);
    }
  }

  const allDates = Array.from(dateSet).filter(isDateKey).sort();

  const perTicker = {};
  for (const [tRaw, series] of Object.entries(historySeries || {})) {
    const t = String(tRaw).toUpperCase();
    const timestamps = Array.isArray(series?.timestamps) ? series.timestamps : [];
    const closes = Array.isArray(series?.close) ? series.close : [];
    const keys = [];
    const vals = [];
    for (let i = 0; i < Math.min(timestamps.length, closes.length); i++) {
      const k = dateKeyFromUnixSeconds(timestamps[i]);
      const c = Number(closes[i]);
      if (!k || !Number.isFinite(c)) continue;
      keys.push(k);
      vals.push(c);
    }
    perTicker[t] = { keys, vals, i: 0, last: null };
  }

  const heldQty = {};
  let cash = 0;
  let index = 1;
  let prevValue = 0;
  let started = false;
  const points = [];

  for (const day of allDates) {
    const dayEvents = events[day] || { buys: [], sells: [] };

    const lastClose = {};
    for (const [t, st] of Object.entries(perTicker)) {
      while (st.i < st.keys.length && st.keys[st.i] <= day) {
        st.last = st.vals[st.i];
        st.i += 1;
      }
      lastClose[t] = st.last;
    }

    if (liveDayKey && day === liveDayKey) {
      for (const [tRaw, q] of Object.entries(liveQuotes || {})) {
        const t = String(tRaw).toUpperCase();
        const price = Number(q?.price);
        if (Number.isFinite(price)) lastClose[t] = price;
      }
    }

    let external = 0;

    for (const s of dayEvents.sells) {
      const t = s.ticker;
      const qty = Number(s.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const price = Number.isFinite(s.exitPrice) ? s.exitPrice : Number(lastClose[t] ?? unitFallback[t]);
      const proceeds = Number.isFinite(price) ? qty * price : 0;
      cash += proceeds;
      heldQty[t] = (heldQty[t] || 0) - qty;
    }

    for (const b of dayEvents.buys) {
      const t = b.ticker;
      const qty = Number(b.qty);
      const cost = Number(b.cost);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cost) || cost <= 0) continue;

      const needed = cash < cost ? cost - cash : 0;
      if (needed > 0) {
        cash += needed;
        external += needed;
      }

      cash -= cost;
      heldQty[t] = (heldQty[t] || 0) + qty;
    }

    let holdingsValue = 0;
    for (const [t, qtyRaw] of Object.entries(heldQty)) {
      const qty = Number(qtyRaw);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const price = Number(lastClose[t] ?? unitFallback[t]);
      if (!Number.isFinite(price)) continue;
      holdingsValue += qty * price;
    }

    const value = cash + holdingsValue;
    if (!started) {
      if (external <= 0 && value <= 0) continue;
      started = true;
    }

    const base = prevValue + external;
    const r = base > 0 ? (value - base) / base : 0;
    index *= 1 + (Number.isFinite(r) ? r : 0);
    const dayReturnPct = Number.isFinite(r) ? r * 100 : null;
    points.push({
      day,
      pct: (index - 1) * 100,
      dayReturnPct,
      value,
      holdingsValue,
      cash,
      external,
    });
    prevValue = value;
  }

  return points;
}

function renderTWRChartSVG(points, { container, meta, errors } = {}) {
  if (!container) return;
  const list = Array.isArray(points) ? points : [];

  if (errors && Object.keys(errors).length) {
    const bad = Object.entries(errors)
      .slice(0, 6)
      .map(([t, msg]) => `${t}: ${msg}`)
      .join(" · ");
    if (meta) meta.textContent = `Grafik kismi: ${bad}`;
  } else if (meta) {
    meta.textContent = "";
  }

  if (list.length < 2) {
    container.innerHTML = `<div class="subtle">Grafik icin yeterli veri yok veya sunucu kapali. Yerel sunucu ile ac: <code>py -3 server.py 8000</code> veya <code>node server.mjs</code></div>`;
    return;
  }

  const first = list[0];
  const last = list[list.length - 1];
  const lastPct = last?.pct;
  if (meta && Number.isFinite(lastPct)) {
    meta.textContent = `${first.day} -> ${last.day} · TWR: ${formatSignedPct(lastPct)}`;
  }

  const t0 = Date.parse(`${first.day}T00:00:00Z`);
  const t1 = Date.parse(`${last.day}T00:00:00Z`);
  const w = 1000;
  const h = 260;
  const padX = 20;
  const padY = 22;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of list) {
    if (!Number.isFinite(p.pct)) continue;
    minY = Math.min(minY, p.pct);
    maxY = Math.max(maxY, p.pct);
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    container.innerHTML = `<div class="subtle">Grafik icin veri okunamadi.</div>`;
    return;
  }

  const range = maxY - minY || 1;
  const minPad = minY - range * 0.1;
  const maxPad = maxY + range * 0.1;
  const yRange = maxPad - minPad || 1;

  const xFor = (day) => {
    const t = Date.parse(`${day}T00:00:00Z`);
    const r = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return padX + r * (w - padX * 2);
  };

  const yFor = (pct) => {
    const r = (maxPad - pct) / yRange;
    return padY + r * (h - padY * 2);
  };

  let d = "";
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const x = xFor(p.day);
    const y = yFor(p.pct);
    d += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }

  const y0 = 0 >= minPad && 0 <= maxPad ? yFor(0) : null;

  container.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Portfoy TWR grafigi">
      ${y0 != null ? `<line class="chartZero" x1="${padX}" y1="${y0.toFixed(2)}" x2="${w - padX}" y2="${y0.toFixed(2)}" />` : ""}
      <path class="chartLine" d="${d}" />
    </svg>
  `.trim();
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function parseDayKeyUTC(dayKey) {
  if (!isDateKey(dayKey)) return null;
  const t = Date.parse(`${dayKey}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

function formatShortDateTR(dayKey) {
  const t = parseDayKeyUTC(dayKey);
  if (t == null) return String(dayKey ?? NA);
  return new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short" }).format(new Date(t));
}

function formatLongDateTR(dayKey) {
  const t = parseDayKeyUTC(dayKey);
  if (t == null) return String(dayKey ?? NA);
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(t));
}

function metricLabel(metric) {
  return metric === "value" ? "Değer" : "Getiri (TWR)";
}

function formatMetricValue(metric, p) {
  if (metric === "value") return formatTL(p?.value);
  return formatSignedPct(p?.pct);
}

function seriesIndexFromPct(pct) {
  const x = Number(pct);
  if (!Number.isFinite(x)) return null;
  return 1 + x / 100;
}

function seriesReturnBetween(aPct, bPct) {
  const a = seriesIndexFromPct(aPct);
  const b = seriesIndexFromPct(bPct);
  if (a == null || b == null || a <= 0) return null;
  return ((b / a) - 1) * 100;
}

function computeMaxDrawdownPct(points) {
  let peak = -Infinity;
  let maxDD = 0;
  for (const p of points) {
    const idx = seriesIndexFromPct(p?.pct);
    if (idx == null || idx <= 0) continue;
    if (idx > peak) peak = idx;
    const dd = peak > 0 ? (idx / peak - 1) * 100 : 0;
    if (dd < maxDD) maxDD = dd;
  }
  return Number.isFinite(maxDD) ? maxDD : null;
}

function nearestIndexByTime(list, t) {
  if (!list.length) return -1;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (list[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo <= 0) return 0;
  if (lo >= list.length) return list.length - 1;
  const a = list[lo - 1];
  const b = list[lo];
  return Math.abs(a.t - t) <= Math.abs(b.t - t) ? lo - 1 : lo;
}

function viewForRange(points, range) {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const endT = last.t;
  const startAll = first.t;

  const clampView = (t0, t1) => {
    const a = clamp(t0, startAll, endT);
    const b = clamp(t1, startAll, endT);
    const minSpan = 3 * 24 * 60 * 60 * 1000;
    if (b - a < minSpan) return { t0: Math.max(startAll, b - minSpan), t1: b };
    return { t0: Math.min(a, b), t1: Math.max(a, b) };
  };

  const dayMs = 24 * 60 * 60 * 1000;
  if (range === "1W") return clampView(endT - 7 * dayMs, endT);
  if (range === "1M") return clampView(endT - 31 * dayMs, endT);
  if (range === "3M") return clampView(endT - 93 * dayMs, endT);
  if (range === "6M") return clampView(endT - 186 * dayMs, endT);
  if (range === "1Y") return clampView(endT - 366 * dayMs, endT);
  if (range === "YTD") {
    const endD = new Date(endT);
    const jan1 = Date.UTC(endD.getUTCFullYear(), 0, 1);
    return clampView(jan1, endT);
  }
  return clampView(startAll, endT);
}

const CHART_WIDGETS = new WeakMap();

function dayKeyFromUTCDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function addDaysToDayKey(dayKey, days) {
  const t = parseDayKeyUTC(dayKey);
  if (t == null) return null;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return dayKeyFromUTCDate(d);
}

function addMonthsToDayKey(dayKey, months) {
  const t = parseDayKeyUTC(dayKey);
  if (t == null) return null;
  const d = new Date(t);

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  const firstOfTarget = new Date(Date.UTC(year, month + Number(months || 0), 1));
  const lastDayOfTargetMonth = new Date(
    Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)
  ).getUTCDate();

  firstOfTarget.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return dayKeyFromUTCDate(firstOfTarget);
}

function firstPointOnOrAfterDayKey(points, dayKey) {
  const list = Array.isArray(points) ? points : [];
  if (!isDateKey(dayKey)) return null;
  for (const p of list) {
    const k = String(p?.day ?? "");
    if (!isDateKey(k)) continue;
    if (k >= dayKey) return p;
  }
  return null;
}

function renderChartPerformance(points) {
  const grid = document.getElementById("chart-perf-grid");
  if (!grid) return;

  const list = Array.isArray(points) ? points : [];
  const end = list.length ? list[list.length - 1] : null;
  const endDay = String(end?.day ?? "");
  const endPct = end?.pct;

  const renderNA = () => {
    renderStatGrid(grid, [
      statHTML("Haftalık", NA),
      statHTML("Aylık", NA),
      statHTML("3 Aylık", NA),
      statHTML("6 Aylık", NA),
      statHTML("YBB", NA),
      statHTML("12 Aylık", NA),
    ]);
  };

  if (!isDateKey(endDay) || !Number.isFinite(Number(endPct))) {
    renderNA();
    return;
  }

  const endD = new Date(parseDayKeyUTC(endDay));
  const ytdStart = `${endD.getUTCFullYear()}-01-01`;

  const startW = addDaysToDayKey(endDay, -7);
  const startM = addMonthsToDayKey(endDay, -1);
  const start3M = addMonthsToDayKey(endDay, -3);
  const start6M = addMonthsToDayKey(endDay, -6);
  const start12M = addMonthsToDayKey(endDay, -12);

  const calc = (startKey) => {
    if (!startKey) return null;
    const startPoint = firstPointOnOrAfterDayKey(list, startKey);
    if (!startPoint || !Number.isFinite(Number(startPoint.pct))) return null;
    return seriesReturnBetween(startPoint.pct, endPct);
  };

  const w = calc(startW);
  const m = calc(startM);
  const m3 = calc(start3M);
  const m6 = calc(start6M);
  const ytd = calc(ytdStart);
  const m12 = calc(start12M);

  const v = (x) => (x == null ? NA : formatSignedPct(x));
  const c = (x) => signedClass(x, { nanClass: "" });

  renderStatGrid(grid, [
    statHTML("Haftalık", v(w), c(w)),
    statHTML("Aylık", v(m), c(m)),
    statHTML("3 Aylık", v(m3), c(m3)),
    statHTML("6 Aylık", v(m6), c(m6)),
    statHTML("YBB", v(ytd), c(ytd)),
    statHTML("12 Aylık", v(m12), c(m12)),
  ]);
}

const TWR_ECHART_WIDGETS = new WeakMap();

function ensureTwrEChartWidget(container) {
  const existing = TWR_ECHART_WIDGETS.get(container);
  if (existing) return existing;

  container.innerHTML = `
    <div class="chartToolbar" role="group" aria-label="Grafik kontrolleri">
      <div class="segmented" role="group" aria-label="Metrik">
        <button class="segBtn" type="button" data-metric="pct" aria-pressed="true">% Getiri</button>
        <button class="segBtn" type="button" data-metric="value" aria-pressed="false">Değer</button>
      </div>
      <div class="rangePills" role="group" aria-label="Zaman aralığı">
        <button class="pillBtn" type="button" data-range="1W">1H</button>
        <button class="pillBtn" type="button" data-range="1M">1A</button>
        <button class="pillBtn" type="button" data-range="3M">3A</button>
        <button class="pillBtn" type="button" data-range="6M">6A</button>
        <button class="pillBtn" type="button" data-range="YTD">YTD</button>
        <button class="pillBtn" type="button" data-range="1Y">1Y</button>
        <button class="pillBtn" type="button" data-range="ALL">Tümü</button>
      </div>
      <div class="chartActions">
        <span class="chartKpi subtle" data-role="kpi"></span>
        <button class="btn btn-ghost btn-sm" type="button" data-action="download-png">PNG</button>
        <button class="btn btn-ghost btn-sm" type="button" data-action="download-csv">CSV</button>
      </div>
    </div>
    <div class="chartStage" tabindex="0" role="application" aria-label="Portföy grafiği">
      <div class="chartEcharts" data-role="echarts"></div>
      <div class="chartEmpty subtle" data-role="empty" hidden></div>
    </div>
  `.trim();

  const stage = container.querySelector(".chartStage");
  const chartEl = container.querySelector('[data-role="echarts"]');
  const empty = container.querySelector('[data-role="empty"]');
  const kpi = container.querySelector('[data-role="kpi"]');

  const state = {
    metric: STATE.ui.chartPrefs?.metric === "value" ? "value" : "pct",
    range: typeof STATE.ui.chartPrefs?.range === "string" ? STATE.ui.chartPrefs.range : "ALL",
    points: [],
    view: null,
  };

  const setStatus = (message) => {
    if (!empty) return;
    const msg = String(message ?? "").trim();
    if (!msg) {
      empty.setAttribute("hidden", "");
      empty.textContent = "";
      return;
    }
    empty.textContent = msg;
    empty.removeAttribute("hidden");
  };

  const setMetricButtons = () => {
    for (const btn of Array.from(container.querySelectorAll("button[data-metric]"))) {
      btn.setAttribute("aria-pressed", btn.dataset.metric === state.metric ? "true" : "false");
    }
  };

  const setRangeButtons = () => {
    for (const btn of Array.from(container.querySelectorAll("button[data-range]"))) {
      btn.setAttribute("aria-pressed", btn.dataset.range === state.range ? "true" : "false");
    }
  };

  const visiblePoints = () => {
    if (!state.view) return state.points;
    const { t0, t1 } = state.view;
    return state.points.filter((p) => p.t >= t0 && p.t <= t1);
  };

  const computeRangeReturnPct = (pts) => {
    if (pts.length < 2) return null;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (state.metric === "pct") return seriesReturnBetween(first?.pct, last?.pct);
    const a = Number(first?.value);
    const b = Number(last?.value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
    return ((b / a) - 1) * 100;
  };

  const updateKpi = () => {
    if (!kpi) return;
    const pts = visiblePoints();
    if (pts.length < 2) {
      kpi.textContent = "";
      return;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const ret = computeRangeReturnPct(pts);
    const dd = computeMaxDrawdownPct(pts);
    const retTxt = ret == null ? NA : formatSignedPct(ret);
    const ddTxt = dd == null ? NA : formatSignedPct(dd);
    kpi.textContent = `${metricLabel(state.metric)} • ${formatShortDateTR(first.day)} → ${formatShortDateTR(
      last.day
    )} • Getiri: ${retTxt} • Max DD: ${ddTxt}`;
  };

  const hasEcharts = typeof window !== "undefined" && !!window.echarts && !!chartEl;
  const chart = hasEcharts ? window.echarts.init(chartEl, null, { renderer: "canvas" }) : null;

  const render = () => {
    if (!hasEcharts || !chart) {
      setStatus(
        "Profesyonel grafik için ECharts yüklenemedi. Sunucu ile açmayı dene (py -3 server.py 8000 veya node server.mjs)."
      );
      return;
    }

    if (!state.points.length) {
      chart.clear();
      updateKpi();
      return;
    }

    if (!["1W", "1M", "3M", "6M", "YTD", "1Y", "ALL", "CUSTOM"].includes(state.range)) state.range = "ALL";
    state.view = viewForRange(state.points, state.range === "CUSTOM" ? "ALL" : state.range) || null;

    const pts = visiblePoints();
    if (pts.length < 2) {
      chart.clear();
      updateKpi();
      return;
    }

    const ret = computeRangeReturnPct(pts);
    const isPct = state.metric === "pct";

    const palette = {
      good: { line: "#34c759", fill: "rgba(52, 199, 89, 0.22)" },
      bad: { line: "#ff453a", fill: "rgba(255, 69, 58, 0.22)" },
      neutral: { line: "#f5f5f7", fill: "rgba(245, 245, 247, 0.16)" },
    };
    const theme = ret != null && ret > 0 ? palette.good : ret != null && ret < 0 ? palette.bad : palette.neutral;

    const seriesData = state.points.map((p) => [p.t, state.metric === "value" ? Number(p.value) : Number(p.pct)]);
    const t0 = state.view?.t0 ?? pts[0].t;
    const t1 = state.view?.t1 ?? pts[pts.length - 1].t;

    const option = {
      animation: false,
      grid: { left: 56, right: 18, top: 14, bottom: 54 },
      xAxis: {
        type: "time",
        boundaryGap: false,
        axisLine: { lineStyle: { color: "rgba(245,245,247,0.20)" } },
        axisTick: { show: false },
        axisLabel: {
          color: "rgba(245,245,247,0.62)",
          formatter: (value) =>
            new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short" }).format(new Date(value)),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: "rgba(245,245,247,0.70)",
          formatter: (v) => (isPct ? formatSignedPct(Number(v)) : formatTL(Number(v))),
        },
        splitLine: { show: true, lineStyle: { color: "rgba(245,245,247,0.08)" } },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: {
          type: "cross",
          label: { backgroundColor: "rgba(29,29,31,0.90)", borderColor: "rgba(245,245,247,0.16)" },
          lineStyle: { color: "rgba(245,245,247,0.18)" },
        },
        backgroundColor: "rgba(29,29,31,0.82)",
        borderColor: "rgba(245,245,247,0.14)",
        borderWidth: 1,
        textStyle: { color: "#f5f5f7", fontFamily: '"Inter Tight", system-ui, -apple-system, Segoe UI, Roboto, Arial' },
        extraCssText: "border-radius: 14px; backdrop-filter: blur(14px);",
        formatter: (params) => {
          const p0 = Array.isArray(params) ? params[0] : null;
          const idx = p0 ? Number(p0.dataIndex) : null;
          const pt = Number.isFinite(idx) ? state.points[idx] : null;
          if (!pt) return "";
          const date = formatLongDateTR(pt.day);
          const main = isPct ? formatSignedPct(pt.pct) : formatTL(pt.value);
          const dayRet = pt.dayReturnPct == null ? NA : formatSignedPct(pt.dayReturnPct);
          return `<div style="font-size:12px;color:rgba(245,245,247,0.70)">${escapeHTML(
            date
          )}</div><div style="margin-top:3px;font-size:16px;font-weight:600">${escapeHTML(
            main
          )}</div><div style="margin-top:4px;font-size:12px;color:rgba(245,245,247,0.78)">Günlük: ${escapeHTML(
            dayRet
          )}</div>`;
        },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, startValue: t0, endValue: t1, filterMode: "none" },
        {
          type: "slider",
          xAxisIndex: 0,
          startValue: t0,
          endValue: t1,
          height: 18,
          bottom: 8,
          borderColor: "rgba(245,245,247,0.10)",
          backgroundColor: "rgba(0,0,0,0.12)",
          fillerColor: "rgba(245,245,247,0.10)",
          handleStyle: { color: "rgba(245,245,247,0.35)", borderColor: "rgba(245,245,247,0.12)" },
          textStyle: { color: "rgba(245,245,247,0.55)" },
        },
      ],
      series: [
        {
          type: "line",
          name: metricLabel(state.metric),
          showSymbol: false,
          smooth: true,
          data: seriesData,
          lineStyle: { width: 2.6, color: theme.line },
          areaStyle: {
            color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: theme.fill },
              { offset: 1, color: "rgba(245,245,247,0)" },
            ]),
          },
          emphasis: { lineStyle: { width: 3.2 } },
          markLine: isPct
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { type: "dashed", color: "rgba(245,245,247,0.18)" },
                data: [{ yAxis: 0 }],
              }
            : undefined,
        },
      ],
    };

    setStatus("");
    chart.setOption(option, true);
    updateKpi();
  };

  const setData = (points) => {
    const raw = Array.isArray(points) ? points : [];
    state.points = raw
      .map((p) => {
        const t = parseDayKeyUTC(p?.day);
        return t == null ? null : { ...p, t };
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
    render();
  };

  const setMetric = (metric) => {
    if (metric !== "pct" && metric !== "value") return;
    state.metric = metric;
    STATE.ui.chartPrefs.metric = metric;
    setMetricButtons();
    render();
  };

  const setRange = (range) => {
    if (!["1W", "1M", "3M", "6M", "YTD", "1Y", "ALL", "CUSTOM"].includes(range)) return;
    state.range = range;
    STATE.ui.chartPrefs.range = range;
    setRangeButtons();
    render();
  };

  const toDataURL = ({ pixelRatio = 2, backgroundColor = "#141416" } = {}) => {
    if (!chart) return null;
    const pr = Number(pixelRatio);
    const bg = typeof backgroundColor === "string" && backgroundColor.trim() ? backgroundColor : "#141416";
    return chart.getDataURL({ type: "png", pixelRatio: Number.isFinite(pr) ? pr : 2, backgroundColor: bg });
  };

  const downloadPNG = () => {
    const url = toDataURL();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `grafik-${state.metric}.png`;
    a.click();
  };

  const downloadCSV = () => {
    const pts = visiblePoints();
    const lines = ["day,pct,value,dayReturnPct"];
    for (const p of pts) {
      const day = String(p?.day ?? "");
      const pct = p?.pct == null ? "" : String(p.pct);
      const value = p?.value == null ? "" : String(p.value);
      const dayReturnPct = p?.dayReturnPct == null ? "" : String(p.dayReturnPct);
      lines.push([day, pct, value, dayReturnPct].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `grafik-${state.metric}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  container.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button");
    if (!btn) return;

    const metric = btn.dataset?.metric;
    if (metric) return setMetric(metric);

    const range = btn.dataset?.range;
    if (range) return setRange(range);

    const action = btn.dataset?.action;
    if (action === "download-png") downloadPNG();
    if (action === "download-csv") downloadCSV();
  });

  if (chart) {
    chart.on("dataZoom", (ev) => {
      const b = Array.isArray(ev?.batch) ? ev.batch[0] : null;
      if (b && Number.isFinite(Number(b.startValue)) && Number.isFinite(Number(b.endValue))) {
        state.range = "CUSTOM";
        STATE.ui.chartPrefs.range = "CUSTOM";
        state.view = { t0: Number(b.startValue), t1: Number(b.endValue) };
        setRangeButtons();
        updateKpi();
      }
    });
  }

  const resize = () => chart?.resize?.();
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  if (ro && stage) ro.observe(stage);

  const widget = { setData, setMetric, setRange, setStatus, resize, toDataURL };
  TWR_ECHART_WIDGETS.set(container, widget);

  setMetricButtons();
  setRangeButtons();
  resize();
  return widget;
}

function ensureTwrChartWidget(container) {
  const existing = CHART_WIDGETS.get(container);
  if (existing) return existing;

  container.innerHTML = `
    <div class="chartToolbar" role="group" aria-label="Grafik kontrolleri">
      <div class="segmented" role="group" aria-label="Metrik">
        <button class="segBtn" type="button" data-metric="pct" aria-pressed="true">% Getiri</button>
        <button class="segBtn" type="button" data-metric="value" aria-pressed="false">Değer</button>
      </div>
      <div class="rangePills" role="group" aria-label="Zaman aralığı">
        <button class="pillBtn" type="button" data-range="1W">1H</button>
        <button class="pillBtn" type="button" data-range="1M">1A</button>
        <button class="pillBtn" type="button" data-range="3M">3A</button>
        <button class="pillBtn" type="button" data-range="6M">6A</button>
        <button class="pillBtn" type="button" data-range="YTD">YTD</button>
        <button class="pillBtn" type="button" data-range="1Y">1Y</button>
        <button class="pillBtn" type="button" data-range="ALL">Tümü</button>
      </div>
      <div class="chartActions">
        <span class="chartKpi subtle" data-role="kpi"></span>
        <button class="btn btn-ghost btn-sm" type="button" data-action="download-png">PNG</button>
        <button class="btn btn-ghost btn-sm" type="button" data-action="download-csv">CSV</button>
      </div>
    </div>
    <div class="chartStage" tabindex="0" role="application" aria-label="Portföy grafiği">
      <canvas class="chartCanvas"></canvas>
      <div class="chartEmpty subtle" data-role="empty" hidden></div>
      <div class="chartTooltip" data-role="tooltip" hidden></div>
    </div>
  `.trim();

  const canvas = container.querySelector("canvas.chartCanvas");
  const stage = container.querySelector(".chartStage");
  const tooltip = container.querySelector('[data-role="tooltip"]');
  const empty = container.querySelector('[data-role="empty"]');
  const kpi = container.querySelector('[data-role="kpi"]');
  const ctx = canvas?.getContext?.("2d");

  const state = {
    metric: STATE.ui.chartPrefs?.metric === "value" ? "value" : "pct",
    range: typeof STATE.ui.chartPrefs?.range === "string" ? STATE.ui.chartPrefs.range : "ALL",
    points: [],
    view: null,
    hoverIndex: null,
    dragging: null,
    dpr: 1,
  };

  const setStatus = (message) => {
    if (!empty) return;
    const msg = String(message ?? "").trim();
    if (!msg) {
      empty.setAttribute("hidden", "");
      empty.textContent = "";
      return;
    }
    empty.textContent = msg;
    empty.removeAttribute("hidden");
  };

  const setMetricButtons = () => {
    for (const btn of Array.from(container.querySelectorAll("button[data-metric]"))) {
      btn.setAttribute("aria-pressed", btn.dataset.metric === state.metric ? "true" : "false");
    }
  };

  const setRangeButtons = () => {
    for (const btn of Array.from(container.querySelectorAll("button[data-range]"))) {
      btn.setAttribute("aria-pressed", btn.dataset.range === state.range ? "true" : "false");
    }
  };

  const currentPlotRect = () => {
    if (!canvas) return { left: 0, top: 0, right: 0, bottom: 0 };
    const padL = Math.round(46 * state.dpr);
    const padR = Math.round(16 * state.dpr);
    const padT = Math.round(14 * state.dpr);
    const padB = Math.round(28 * state.dpr);
    return { left: padL, top: padT, right: canvas.width - padR, bottom: canvas.height - padB };
  };

  const visiblePoints = () => {
    if (!state.view) return [];
    const { t0, t1 } = state.view;
    const out = [];
    for (const p of state.points) {
      if (p.t < t0) continue;
      if (p.t > t1) break;
      out.push(p);
    }
    return out;
  };

  const draw = () => {
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!state.points.length || !state.view) {
      if (empty?.hasAttribute("hidden")) setStatus("Grafik için veri yok.");
      return;
    }
    setStatus("");

    const pts = visiblePoints();
    if (pts.length < 2) {
      if (empty?.hasAttribute("hidden")) setStatus("Grafik için yeterli veri yok.");
      return;
    }

    const plot = currentPlotRect();
    const plotW = Math.max(1, plot.right - plot.left);
    const plotH = Math.max(1, plot.bottom - plot.top);
    const spanT = state.view.t1 - state.view.t0 || 1;

    const yOf = (p) => (state.metric === "value" ? Number(p.value) : Number(p.pct));
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      const y = yOf(p);
      if (!Number.isFinite(y)) continue;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
      setStatus("Grafik için veri okunamadı.");
      return;
    }

    if (state.metric === "pct") {
      minY = Math.min(minY, 0);
      maxY = Math.max(maxY, 0);
    }

    const ySpan = maxY - minY || 1;
    const pad = ySpan * 0.12;
    const yMin = minY - pad;
    const yMax = maxY + pad;
    const yRange = yMax - yMin || 1;

    const xForT = (t) => plot.left + ((t - state.view.t0) / spanT) * plotW;
    const yForV = (v) => plot.top + ((yMax - v) / yRange) * plotH;

    const first = pts[0];
    const last = pts[pts.length - 1];
    const themeGood = "#34c759";
    const themeBad = "#ff453a";
    const themeText = "#f5f5f7";
    const themeGrid = "rgba(245,245,247,0.10)";
    const themeGrid2 = "rgba(245,245,247,0.06)";

    const rangeRetPct =
      state.metric === "pct"
        ? seriesReturnBetween(first?.pct, last?.pct)
        : (() => {
            const a = Number(first?.value);
            const b = Number(last?.value);
            if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
            return ((b / a) - 1) * 100;
          })();

    const lineColor =
      rangeRetPct != null && rangeRetPct > 0 ? themeGood : rangeRetPct != null && rangeRetPct < 0 ? themeBad : themeText;

    if (kpi) {
      const dd = computeMaxDrawdownPct(pts);
      const retTxt = rangeRetPct == null ? NA : formatSignedPct(rangeRetPct);
      const ddTxt = dd == null ? NA : formatSignedPct(dd);
      kpi.textContent = `${metricLabel(state.metric)} • ${formatShortDateTR(first.day)} → ${formatShortDateTR(
        last.day
      )} • Getiri: ${retTxt} • Max DD: ${ddTxt}`;
    }

    ctx.save();
    ctx.font = `${Math.round(11 * state.dpr)}px "Inter Tight", system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
    ctx.textBaseline = "middle";

    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = plot.top + (i / gridLines) * plotH;
      ctx.strokeStyle = i === 0 || i === gridLines ? themeGrid : themeGrid2;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(245,245,247,0.70)";
    const labelCount = 4;
    for (let i = 0; i <= labelCount; i++) {
      const v = yMax - (i / labelCount) * yRange;
      const y = yForV(v);
      const txt = state.metric === "value" ? formatTL(v) : formatSignedPct(v);
      ctx.fillText(String(txt), 4 * state.dpr, y);
    }

    const axisY0 = state.metric === "pct" && 0 >= yMin && 0 <= yMax ? yForV(0) : null;
    if (axisY0 != null) {
      ctx.strokeStyle = "rgba(245,245,247,0.18)";
      ctx.setLineDash([4 * state.dpr, 4 * state.dpr]);
      ctx.beginPath();
      ctx.moveTo(plot.left, axisY0);
      ctx.lineTo(plot.right, axisY0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const xLabelY = canvas.height - Math.round(14 * state.dpr);
    ctx.fillStyle = "rgba(245,245,247,0.62)";
    ctx.textBaseline = "alphabetic";
    const leftLbl = formatShortDateTR(first.day);
    const midLbl = formatShortDateTR(pts[Math.floor(pts.length / 2)].day);
    const rightLbl = formatShortDateTR(last.day);
    ctx.fillText(leftLbl, plot.left, xLabelY);
    const midW = ctx.measureText(midLbl).width;
    ctx.fillText(midLbl, plot.left + plotW / 2 - midW / 2, xLabelY);
    const rightW = ctx.measureText(rightLbl).width;
    ctx.fillText(rightLbl, plot.right - rightW, xLabelY);

    const baselineY = axisY0 != null ? axisY0 : plot.bottom;
    const gradient = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
    const gBase = lineColor === themeBad ? "255,69,58" : lineColor === themeGood ? "52,199,89" : "245,245,247";
    gradient.addColorStop(0, `rgba(${gBase},0.30)`);
    gradient.addColorStop(1, `rgba(${gBase},0.02)`);

    const buildPath = () => {
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const yV = yOf(p);
        if (!Number.isFinite(yV)) continue;
        const x = xForT(p.t);
        const y = yForV(yV);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    };

    buildPath();
    ctx.lineWidth = 2.25 * state.dpr;
    ctx.strokeStyle = lineColor;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    buildPath();
    ctx.lineTo(xForT(last.t), baselineY);
    ctx.lineTo(xForT(first.t), baselineY);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    if (state.hoverIndex != null && state.hoverIndex >= 0 && state.hoverIndex < pts.length) {
      const hp = pts[state.hoverIndex];
      const yV = yOf(hp);
      if (Number.isFinite(yV)) {
        const x = xForT(hp.t);
        const y = yForV(yV);
        ctx.strokeStyle = "rgba(245,245,247,0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, plot.top);
        ctx.lineTo(x, plot.bottom);
        ctx.stroke();

        ctx.fillStyle = lineColor;
        ctx.beginPath();
        ctx.arc(x, y, 3.4 * state.dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "rgba(29,29,31,0.85)";
        ctx.lineWidth = 2 * state.dpr;
        ctx.beginPath();
        ctx.arc(x, y, 4.6 * state.dpr, 0, Math.PI * 2);
        ctx.stroke();

        if (tooltip && stage) {
          const dp = hp.dayReturnPct;
          const dpTxt = dp == null ? NA : formatSignedPct(dp);
          const valTxt = formatMetricValue(state.metric, hp);
          tooltip.innerHTML = `
            <div class="ttDate">${escapeHTML(formatLongDateTR(hp.day))}</div>
            <div class="ttVal">${escapeHTML(valTxt)}</div>
            <div class="ttSub subtle">Günlük: ${escapeHTML(dpTxt)}</div>
          `.trim();
          tooltip.removeAttribute("hidden");

          const stageRect = stage.getBoundingClientRect();
          const boxW = 220;
          const boxH = 76;
          const px = x / state.dpr + 12;
          const py = y / state.dpr - boxH - 10;
          const left = clamp(px, 8, stageRect.width - boxW - 8);
          const top = clamp(py, 8, stageRect.height - boxH - 8);
          tooltip.style.left = `${left}px`;
          tooltip.style.top = `${top}px`;
        }
      }
    } else if (tooltip) {
      tooltip.setAttribute("hidden", "");
      tooltip.innerHTML = "";
    }

    ctx.restore();
  };

  const resize = () => {
    if (!canvas || !stage || !ctx) return;
    const rect = stage.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    state.dpr = dpr;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    draw();
  };

  const setData = (points) => {
    const raw = Array.isArray(points) ? points : [];
    const mapped = raw
      .map((p) => {
        const t = parseDayKeyUTC(p?.day);
        return t == null ? null : { ...p, t };
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);

    state.points = mapped;
    if (!mapped.length) {
      state.view = null;
      draw();
      return;
    }

    if (!["1W", "1M", "3M", "6M", "YTD", "1Y", "ALL", "CUSTOM"].includes(state.range)) state.range = "ALL";
    state.view = viewForRange(mapped, state.range === "CUSTOM" ? "ALL" : state.range) || null;
    setMetricButtons();
    setRangeButtons();
    resize();
  };

  const setMetric = (metric) => {
    if (metric !== "pct" && metric !== "value") return;
    state.metric = metric;
    STATE.ui.chartPrefs.metric = metric;
    setMetricButtons();
    draw();
  };

  const setRange = (range) => {
    if (!["1W", "1M", "3M", "6M", "YTD", "1Y", "ALL", "CUSTOM"].includes(range)) return;
    state.range = range;
    STATE.ui.chartPrefs.range = range;
    setRangeButtons();
    if (state.points.length) state.view = viewForRange(state.points, range === "CUSTOM" ? "ALL" : range);
    draw();
  };

  const zoomAtX = (clientX, factor) => {
    if (!state.view || !stage || !state.points.length) return;
    const rect = stage.getBoundingClientRect();
    const plot = currentPlotRect();
    const x = (clientX - rect.left) * state.dpr;
    const plotW = Math.max(1, plot.right - plot.left);
    const rel = clamp((x - plot.left) / plotW, 0, 1);
    const span = state.view.t1 - state.view.t0;
    const center = state.view.t0 + rel * span;
    const fullSpan = state.points[state.points.length - 1].t - state.points[0].t;
    const nextSpan = clamp(span * factor, 3 * 24 * 60 * 60 * 1000, fullSpan || span);
    const t0 = center - rel * nextSpan;

    const all = viewForRange(state.points, "ALL");
    const nt0 = clamp(t0, all.t0, all.t1 - nextSpan);
    state.view = { t0: nt0, t1: nt0 + nextSpan };
    state.range = "CUSTOM";
    setRangeButtons();
    draw();
  };

  const panByPx = (deltaPx) => {
    if (!state.view || !state.points.length) return;
    const plot = currentPlotRect();
    const plotW = Math.max(1, plot.right - plot.left);
    const span = state.view.t1 - state.view.t0;
    const dt = (-deltaPx / plotW) * span;

    const all = viewForRange(state.points, "ALL");
    const nt0 = clamp(state.view.t0 + dt, all.t0, all.t1 - span);
    state.view = { t0: nt0, t1: nt0 + span };
    state.range = "CUSTOM";
    setRangeButtons();
    draw();
  };

  const onPointerMove = (e) => {
    if (!stage || !state.view) return;
    if (state.dragging) {
      panByPx(e.clientX - state.dragging.x0);
      state.dragging.x0 = e.clientX;
      return;
    }

    const rect = stage.getBoundingClientRect();
    const plot = currentPlotRect();
    const x = (e.clientX - rect.left) * state.dpr;
    const plotW = Math.max(1, plot.right - plot.left);
    const rel = clamp((x - plot.left) / plotW, 0, 1);
    const t = state.view.t0 + rel * (state.view.t1 - state.view.t0);
    const pts = visiblePoints();
    const idx = nearestIndexByTime(pts, t);
    state.hoverIndex = idx >= 0 ? idx : null;
    draw();
  };

  const onPointerLeave = () => {
    state.hoverIndex = null;
    draw();
  };

  const onPointerDown = (e) => {
    if (!stage) return;
    stage.setPointerCapture?.(e.pointerId);
    state.dragging = { x0: e.clientX };
  };

  const onPointerUp = (e) => {
    if (!stage) return;
    stage.releasePointerCapture?.(e.pointerId);
    state.dragging = null;
  };

  const onWheel = (e) => {
    if (!stage) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 0.88 : 1.14;
    zoomAtX(e.clientX, factor);
  };

  const onKeyDown = (e) => {
    if (!state.view) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      panByPx(80);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      panByPx(-80);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomAtX(stage.getBoundingClientRect().left + stage.getBoundingClientRect().width / 2, 0.9);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomAtX(stage.getBoundingClientRect().left + stage.getBoundingClientRect().width / 2, 1.12);
    } else if (e.key === "Escape") {
      e.preventDefault();
      state.hoverIndex = null;
      draw();
    }
  };

  const download = (name, content, type) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toDataURL = () => {
    if (!canvas) return null;
    return canvas.toDataURL("image/png");
  };

  const downloadPNG = () => {
    const url = toDataURL();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `portfoy-grafik-${todayKey()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadCSV = () => {
    const pts = visiblePoints();
    if (!pts.length) return;
    const rows = [["day", "twr_pct", "value", "day_return_pct"]];
    for (const p of pts) {
      rows.push([
        String(p.day),
        Number.isFinite(Number(p.pct)) ? String(round2(Number(p.pct))) : "",
        Number.isFinite(Number(p.value)) ? String(round2(Number(p.value))) : "",
        Number.isFinite(Number(p.dayReturnPct)) ? String(round2(Number(p.dayReturnPct))) : "",
      ]);
    }
    const csv = rows.map((r) => r.map((x) => `"${String(x).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
    download(`portfoy-grafik-${todayKey()}.csv`, csv, "text/csv;charset=utf-8");
  };

  container.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button");
    if (!btn) return;

    const metric = btn.dataset?.metric;
    if (metric) return setMetric(metric);

    const range = btn.dataset?.range;
    if (range) return setRange(range);

    const action = btn.dataset?.action;
    if (action === "download-png") downloadPNG();
    if (action === "download-csv") downloadCSV();
  });

  if (stage) {
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerleave", onPointerLeave);
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerUp);
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("keydown", onKeyDown);
  }

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  if (ro && stage) ro.observe(stage);

  const widget = { setData, setMetric, setRange, setStatus, resize, toDataURL };
  CHART_WIDGETS.set(container, widget);

  setMetricButtons();
  setRangeButtons();
  resize();
  return widget;
}

function renderTWRChart(points, { container, meta, errors } = {}) {
  if (!container) return;
  const list = Array.isArray(points) ? points : [];
  const widget = ensureTwrEChartWidget(container);

  if (errors && Object.keys(errors).length) {
    const bad = Object.entries(errors)
      .slice(0, 6)
      .map(([t, msg]) => `${t}: ${msg}`)
      .join(" • ");
    if (meta) meta.textContent = `Grafik verisi: ${bad}`;
  } else if (meta) {
    meta.textContent = "";
  }

  if (list.length < 2) {
    widget.setData([]);
    widget.setStatus("Grafik için yeterli veri yok veya sunucu kapalı. Yerel sunucu: py -3 server.py 8000 veya node server.mjs");
    return;
  }

  widget.setStatus("");
  widget.setData(list);
}

async function updateChart(positions) {
  const container = document.getElementById("twr-chart");
  const meta = document.getElementById("twr-meta");
  if (!container) return;

  const widget = ensureTwrEChartWidget(container);
  const tickers = tickersFromPositionsList(positions);
  if (!tickers.length) {
    widget.setData([]);
    widget.setStatus("Grafik için veri yok.");
    if (meta) meta.textContent = "";
    renderChartPerformance([]);
    return;
  }

  const start = minBuyDateKey(positions);
  const end = todayKey();

  if (STATE.history.pending) {
    try {
      STATE.history.pending.abort();
    } catch {
      // ignore
    }
  }

  const controller = new AbortController();
  STATE.history.pending = controller;

  widget.setStatus("Grafik yükleniyor...");

  try {
    await ensureHistory(tickers, { start, end, signal: controller.signal });
  } catch (e) {
    const msg = String(e?.message ?? e);
    const hint = msg.includes("HTTP 404")
      ? "Bu sunucuda /api/history yok. `py -3 server.py 8000` veya `node server.mjs` ile açıp sayfayı yenile."
      : msg;
    widget.setData([]);
    widget.setStatus(`Grafik yüklenemedi: ${hint}`);
    if (meta) meta.textContent = "";
    renderChartPerformance([]);
    return;
  } finally {
    if (STATE.history.pending === controller) STATE.history.pending = null;
  }

  const points = computeTWRSeries(positions, STATE.history.series, { liveQuotes: STATE.quotes });
  renderTWRChart(points, { container, meta, errors: STATE.history.errors });
  renderChartPerformance(points);
}

function scheduleChartUpdate(positions) {
  STATE.ui.lastChartPositions = positions;
  if (STATE.ui.chartScheduled) return;
  STATE.ui.chartScheduled = true;

  window.requestAnimationFrame(() => {
    STATE.ui.chartScheduled = false;
    updateChart(STATE.ui.lastChartPositions || []);
  });
}

function buildSummary(positions) {
  const open = positions.filter((p) => !p.sellDate);
  const closed = positions.filter((p) => p.sellDate);

  const activeAgg = open.reduce(
    (acc, p) => {
      const rr = calcRiskReward(p);
      return {
        invested: acc.invested + (Number(rr.invested) || 0),
        riskTL: acc.riskTL + (Number(rr.riskTL) || 0),
        rewardTL: acc.rewardTL + (Number(rr.rewardTL) || 0),
      };
    },
    { invested: 0, riskTL: 0, rewardTL: 0 }
  );

  const activeRiskPct = activeAgg.invested ? (activeAgg.riskTL / activeAgg.invested) * 100 : null;
  const activeRewardPct = activeAgg.invested ? (activeAgg.rewardTL / activeAgg.invested) * 100 : null;
  const activeRR = activeAgg.riskTL > 0 ? activeAgg.rewardTL / activeAgg.riskTL : null;

  const realizedPnL = closed.reduce(
    (acc, p) => {
      const exitP = exitPriceFromOutcome(p);
      if (exitP == null || !Number.isFinite(exitP)) return acc;
      const { pnlTL, invested } = calcPnL(p, exitP);
      return {
        pnlTL: acc.pnlTL + (Number(pnlTL) || 0),
        invested: acc.invested + (Number(invested) || 0),
      };
    },
    { pnlTL: 0, invested: 0 }
  );
  const realizedPct = realizedPnL.invested ? (realizedPnL.pnlTL / realizedPnL.invested) * 100 : null;

  const closedClassified = closed
    .map((p) => outcomeLabel(p))
    .filter((x) => x === OUTCOME.good || x === OUTCOME.bad);
  const wins = closedClassified.filter((x) => x === OUTCOME.good).length;
  const losses = closedClassified.filter((x) => x === OUTCOME.bad).length;
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : null;

  const liveAgg = open.reduce(
    (acc, p) => {
      const quote = STATE.quotes?.[String(p.symbol ?? "")];
      const price = Number(quote?.price);
      const changeAbs = Number(quote?.changeAbs);
      const qty = approxQuantity(p?.total, p?.unitCost);
      const unitCost = Number(p?.unitCost);

      if (qty == null || !Number.isFinite(unitCost) || !Number.isFinite(price)) return acc;

      const marketValue = qty * price;
      const unreal = qty * (price - unitCost);
      const day = Number.isFinite(changeAbs) ? qty * changeAbs : null;

      return {
        marketValue: acc.marketValue + marketValue,
        unrealized: acc.unrealized + unreal,
        dayChange: acc.dayChange + (Number(day) || 0),
        priced: acc.priced + 1,
      };
    },
    { marketValue: 0, unrealized: 0, dayChange: 0, priced: 0 }
  );

  const hasLive = liveAgg.priced > 0;
  const dayBaseValue = hasLive ? liveAgg.marketValue - liveAgg.dayChange : null;
  const dayChangePct = dayBaseValue ? (liveAgg.dayChange / dayBaseValue) * 100 : null;

  renderHero({
    activeTL: activeAgg.invested,
    currentTL: hasLive ? liveAgg.marketValue : activeAgg.invested,
    dayChangeTL: hasLive ? liveAgg.dayChange : null,
    dayChangePct,
    hasLive,
  });

  renderStatGrid(el.liveGrid, [
    statHTML("Canlı Veri", `${liveAgg.priced}/${open.length}`, liveAgg.priced ? "good" : "warn"),
    statHTML("Canlı Değer", hasLive ? formatTL(liveAgg.marketValue) : NA),
    statHTML(
      "Canlı P/L",
      hasLive ? formatSignedTL(liveAgg.unrealized) : NA,
      hasLive ? signedClass(liveAgg.unrealized) : "warn"
    ),
    statHTML(
      "Günlük P/L",
      hasLive ? formatSignedTL(liveAgg.dayChange) : NA,
      hasLive ? signedClass(liveAgg.dayChange) : "warn"
    ),
    statHTML(
      "Günlük Getiri",
      hasLive ? formatSignedPct(dayChangePct) : NA,
      hasLive ? signedClass(dayChangePct) : "warn"
    ),
  ]);

  renderStatGrid(el.riskGrid, [
    statHTML("Toplam Risk (SL)", formatSignedTL(-activeAgg.riskTL), activeAgg.riskTL > 0 ? "bad" : ""),
    statHTML(
      "Risk Oranı",
      formatSignedPct(activeRiskPct == null ? null : -activeRiskPct),
      activeRiskPct != null && activeRiskPct > 0 ? "bad" : ""
    ),
    statHTML("Potansiyel (TP)", formatSignedTL(activeAgg.rewardTL), activeAgg.rewardTL > 0 ? "good" : ""),
    statHTML(
      "Pot. Getiri",
      formatSignedPct(activeRewardPct),
      activeRewardPct != null && activeRewardPct > 0 ? "good" : ""
    ),
    statHTML(
      "Risk/Ödül",
      activeRR == null || !Number.isFinite(activeRR) ? NA : String(Math.round(activeRR * 100) / 100),
      activeRR != null && activeRR >= 1 ? "good" : "warn"
    ),
  ]);

  renderStatGrid(el.realizedGrid, [
    statHTML("Gerçekleşen P/L", formatSignedTL(realizedPnL.pnlTL), signedClass(realizedPnL.pnlTL, { nanClass: "" })),
    statHTML(
      "Gerçekleşen Getiri",
      formatSignedPct(realizedPct),
      signedClass(realizedPct, { nanClass: "" })
    ),
    statHTML("Kazanma Oranı", formatPct(winRate), winRate != null && winRate >= 50 ? "good" : "warn"),
  ]);

  renderDetailedStats(closed);

  if (STATE.ui.mainTab === "chart") scheduleChartUpdate(positions);
  return;

  const groups = [
    {
      id: "general",
      label: "Genel",
      stats: [
        statHTML("Toplam Pozisyon", String(positions.length)),
        statHTML("Açık", String(open.length)),
        statHTML("Kapalı", String(closed.length)),
        statHTML("Aktif Tutar", formatTL(activeAgg.invested)),
      ],
    },
    {
      id: "live",
      label: "Canlı",
      stats: [
        statHTML("Canlı Veri", `${liveAgg.priced}/${open.length}`, liveAgg.priced ? "good" : "warn"),
        statHTML("Canlı Değer", hasLive ? formatTL(liveAgg.marketValue) : NA),
        statHTML(
          "Canlı P/L",
          hasLive ? formatSignedTL(liveAgg.unrealized) : NA,
          hasLive ? (liveAgg.unrealized > 0 ? "good" : liveAgg.unrealized < 0 ? "bad" : "warn") : "warn"
        ),
        statHTML(
          "Günlük P/L",
          hasLive ? formatSignedTL(liveAgg.dayChange) : NA,
          hasLive ? (liveAgg.dayChange > 0 ? "good" : liveAgg.dayChange < 0 ? "bad" : "warn") : "warn"
        ),
        statHTML(
          "Günlük Getiri",
          hasLive ? formatSignedPct(dayChangePct) : NA,
          hasLive ? (dayChangePct > 0 ? "good" : dayChangePct < 0 ? "bad" : "warn") : "warn"
        ),
      ],
    },
    {
      id: "risk",
      label: "Risk / Hedef",
      stats: [
        statHTML("Toplam Risk (SL)", formatSignedTL(-activeAgg.riskTL), activeAgg.riskTL > 0 ? "bad" : ""),
        statHTML(
          "Risk Oranı",
          formatSignedPct(activeRiskPct == null ? null : -activeRiskPct),
          activeRiskPct != null && activeRiskPct > 0 ? "bad" : ""
        ),
        statHTML("Potansiyel (TP)", formatSignedTL(activeAgg.rewardTL), activeAgg.rewardTL > 0 ? "good" : ""),
        statHTML(
          "Pot. Getiri",
          formatSignedPct(activeRewardPct),
          activeRewardPct != null && activeRewardPct > 0 ? "good" : ""
        ),
        statHTML(
          "Risk/Ödül",
          activeRR == null || !Number.isFinite(activeRR) ? NA : String(Math.round(activeRR * 100) / 100),
          activeRR != null && activeRR >= 1 ? "good" : "warn"
        ),
      ],
    },
    {
      id: "realized",
      label: "Gerçekleşen",
      stats: [
        statHTML("Gerçekleşen P/L", formatSignedTL(realizedPnL.pnlTL), realizedPnL.pnlTL >= 0 ? "good" : "bad"),
        statHTML(
          "Gerçekleşen Getiri",
          formatSignedPct(realizedPct),
          realizedPct != null && realizedPct >= 0 ? "good" : "bad"
        ),
        statHTML("Kazanma Oranı", formatPct(winRate), winRate != null && winRate >= 50 ? "good" : "warn"),
      ],
    },
    {
      id: "chart",
      label: "Grafik",
      contentHTML: `<div class="chartMeta subtle" id="twr-meta"></div><div class="chart" id="twr-chart"></div>`,
      stats: [],
    },
  ];

  el.summary.innerHTML = summaryTabsHTML(groups);
  if (STATE.ui.summaryTab === "chart") scheduleChartUpdate(positions);
}

function renderDetailedStats(closedPositions) {
  const positions = Array.isArray(closedPositions) ? closedPositions : [];
  const trades = [];

  for (const p of positions) {
    const exit = exitPriceFromOutcome(p);
    const { pnlTL, pnlPct } = calcPnL(p, exit);
    if (pnlTL == null || pnlPct == null) continue;

    const outcome = outcomeLabel(p);
    if (outcome !== OUTCOME.good && outcome !== OUTCOME.bad) continue;

    const buy = parseISODate(p?.buyDate);
    const sell = parseISODate(p?.sellDate);
    const holdDays =
      buy && sell && Number.isFinite(buy.getTime()) && Number.isFinite(sell.getTime()) ? (sell - buy) / 86_400_000 : null;

    trades.push({ pnlTL, pnlPct, outcome, holdDays });
  }

  if (!el.detailedStatsGrid) return;

  const n = trades.length;
  const closedCount = positions.length;
  const wins = trades.filter((t) => t.pnlTL > 0);
  const losses = trades.filter((t) => t.pnlTL < 0);
  const breakeven = trades.filter((t) => t.pnlTL === 0);

  const winRate = n ? (wins.length / n) * 100 : null;

  const sum = (arr, pick) => arr.reduce((acc, x) => acc + (Number(pick(x)) || 0), 0);
  const avg = (arr, pick) => (arr.length ? sum(arr, pick) / arr.length : null);

  const totalPnL = sum(trades, (t) => t.pnlTL);
  const totalWins = sum(wins, (t) => t.pnlTL);
  const totalLossesAbs = Math.abs(sum(losses, (t) => t.pnlTL));
  const profitFactor = totalLossesAbs > 0 ? totalWins / totalLossesAbs : totalWins > 0 ? Infinity : null;

  const avgWinPct = avg(wins, (t) => t.pnlPct);
  const avgLossPct = avg(losses, (t) => t.pnlPct);

  const expectancyPct = (() => {
    if (winRate == null) return null;
    const w = winRate / 100;
    const l = 1 - w;
    if (w === 1 && avgWinPct != null) return avgWinPct;
    if (l === 1 && avgLossPct != null) return avgLossPct;
    if (avgWinPct == null || avgLossPct == null) return null;
    return w * avgWinPct + l * avgLossPct;
  })();

  const bestPct = n ? Math.max(...trades.map((t) => t.pnlPct)) : null;
  const worstPct = n ? Math.min(...trades.map((t) => t.pnlPct)) : null;

  const avgHold = avg(trades.filter((t) => t.holdDays != null), (t) => t.holdDays);

  const bySellDate = positions
    .map((p) => {
      const sell = parseISODate(p?.sellDate);
      const exit = exitPriceFromOutcome(p);
      const { pnlTL } = calcPnL(p, exit);
      return { sell, pnlTL };
    })
    .filter((x) => x.sell && x.pnlTL != null)
    .sort((a, b) => a.sell - b.sell);

  let bestWinStreak = 0;
  let bestLossStreak = 0;
  let curWin = 0;
  let curLoss = 0;
  for (const x of bySellDate) {
    if (x.pnlTL > 0) {
      curWin += 1;
      curLoss = 0;
    } else if (x.pnlTL < 0) {
      curLoss += 1;
      curWin = 0;
    } else {
      curWin = 0;
      curLoss = 0;
    }
    if (curWin > bestWinStreak) bestWinStreak = curWin;
    if (curLoss > bestLossStreak) bestLossStreak = curLoss;
  }

  renderStatGrid(el.detailedStatsGrid, [
    statHTML("İşlem", String(n)),
    statHTML("Kazanma", formatPct(winRate), winRate != null && winRate >= 50 ? "good" : "warn"),
    statHTML("Net P/L", formatSignedTL(totalPnL), signedClass(totalPnL, { nanClass: "" })),
    statHTML(
      "Profit Factor",
      profitFactor == null ? NA : profitFactor === Infinity ? "∞" : String(Math.round(profitFactor * 100) / 100),
      profitFactor === Infinity || (profitFactor != null && profitFactor >= 1.2) ? "good" : "warn"
    ),
    statHTML("Ortalama Kazanç %", avgWinPct == null ? NA : formatSignedPct(avgWinPct), signedClass(avgWinPct, { nanClass: "" })),
    statHTML("Beklenti %/işlem", expectancyPct == null ? NA : formatSignedPct(expectancyPct), signedClass(expectancyPct, { nanClass: "" })),
    statHTML("En iyi / En kötü %", bestPct == null || worstPct == null ? NA : `${formatSignedPct(bestPct)} / ${formatSignedPct(worstPct)}`),
    statHTML("Seri (W/L)", n ? `${bestWinStreak}/${bestLossStreak}` : NA),
    statHTML("Ort. Süre (gün)", avgHold == null ? NA : String(Math.round(avgHold * 10) / 10)),
    statHTML("Breakeven", String(breakeven.length)),
  ]);

  if (el.traderVerdict) {
    if (!closedCount) {
      el.traderVerdict.textContent = "";
      return;
    }

    if (!n) {
      el.traderVerdict.textContent =
        "Bu bölüm için değerlendirilebilir kapanış verisi yok. (Kapanmış işlemlerde `outcome`=1/0 ve çıkış için `takeProfit`/`stopLoss` dolu olmalı.)";
      return;
    }

    if (n < 10) {
      el.traderVerdict.textContent = `Veri az (${n} işlem). İstatistiklerin anlamlı olması için biraz daha fazla kapanmış işlem gerekir.`;
      return;
    }

    if (wins.length && !losses.length) {
      el.traderVerdict.textContent =
        "Şu an tüm işlemler kâr görünüyor; bu iyi ama veri tek taraflı. Birkaç kayıplı işlem görmeden sistemin sağlamlığına dair güçlü çıkarım yapmak zor.";
      return;
    }

    if (!wins.length && losses.length) {
      el.traderVerdict.textContent =
        "Şu an tüm işlemler zarar görünüyor; sistem/uygulama tarafında ciddi iyileştirme gerekiyor.";
      return;
    }

    if (expectancyPct != null && expectancyPct > 0) {
      el.traderVerdict.textContent = "Bu veri setinde pozitif beklenti var (uzun vadede artı).";
      return;
    }

    if (expectancyPct != null && expectancyPct <= 0) {
      el.traderVerdict.textContent =
        "Bu veri setinde beklenti nötr/negatif görünüyor; giriş/çıkış ve risk yönetimini gözden geçir.";
      return;
    }

    el.traderVerdict.textContent = "Çıkarım için veri eksik.";
  }
}

function renderTables(items) {
  const open = items.filter((p) => !p.sellDate);
  const closed = items.filter((p) => p.sellDate);

  open.sort((a, b) => {
    const da = parseISODate(a.buyDate)?.getTime() ?? 0;
    const db = parseISODate(b.buyDate)?.getTime() ?? 0;
    if (db !== da) return db - da;
    return String(a.symbol).localeCompare(String(b.symbol), "tr");
  });

  closed.sort((a, b) => {
    const da = parseISODate(a.sellDate)?.getTime() ?? 0;
    const db = parseISODate(b.sellDate)?.getTime() ?? 0;
    if (db !== da) return db - da;
    return String(a.symbol).localeCompare(String(b.symbol), "tr");
  });

  if (el.countOpen) el.countOpen.textContent = `${open.length} Pozisyon`;
  if (el.countClosed) el.countClosed.textContent = `${closed.length} Pozisyon`;

  if (el.tableOpen) el.tableOpen.innerHTML = tableHTML(open, { mode: "openCompact" });
  if (el.tableLive) el.tableLive.innerHTML = tableHTML(open, { mode: "openLive" });
  if (el.tableClosed) el.tableClosed.innerHTML = tableHTML(closed, { mode: "closed" });
}

function tableHTML(items, { mode }) {
  if (mode === "openCompact") {
    const header = `
      <thead>
        <tr>
          <th class="sticky-col">Sembol</th>
          <th class="left">Alış Tarihi</th>
          <th>Maliyet</th>
          <th>Adet</th>
          <th>Tutar</th>
          <th>Günlük %</th>
          <th>Toplam %</th>
          <th>Değer</th>
        </tr>
      </thead>
    `;

    if (!items.length) {
      return (
        header +
        `
          <tbody>
            <tr>
              <th class="sticky-col">${NA}</th>
              <td class="unavailable" colspan="7">Kriterlere uyan pozisyon yok.</td>
            </tr>
          </tbody>
        `
      );
    }

    const rows = items
      .map((p) => {
        const qty = approxQuantity(p.total, p.unitCost);
        const buy = formatDateTR(p.buyDate);
        const symbol = String(p.symbol ?? NA);

        const quote = STATE.quotes?.[symbol];
        const livePrice = Number(quote?.price);
        const liveChangePct = Number(quote?.changePct);
        const unitCost = Number(p?.unitCost);
        const totalChangePct =
          Number.isFinite(livePrice) && Number.isFinite(unitCost) && unitCost !== 0 ? ((livePrice / unitCost) - 1) * 100 : null;
        const liveValue = qty != null && Number.isFinite(livePrice) ? qty * livePrice : null;

        const changeCls = signedClass(liveChangePct);
        const totalCls = signedClass(totalChangePct);

        return `
          <tr>
            <th class="sticky-col">${escapeHTML(symbol)}</th>
            <td class="left cell-muted">${escapeHTML(buy)}</td>
            <td>${escapeHTML(formatTL(p.unitCost))}</td>
            <td class="cell-muted">${escapeHTML(qty == null ? NA : String(qty))}</td>
            <td>${escapeHTML(formatTL(p.total))}</td>
            <td class="cell ${changeCls}">${escapeHTML(Number.isFinite(liveChangePct) ? formatSignedPct(liveChangePct) : NA)}</td>
            <td class="cell ${totalCls}">${escapeHTML(totalChangePct == null ? NA : formatSignedPct(totalChangePct))}</td>
            <td>${escapeHTML(liveValue == null ? NA : formatTL(liveValue))}</td>
          </tr>
        `;
      })
      .join("");

    return `${header}<tbody>${rows}</tbody>`;
  }

  const isOpen = mode === "open" || mode === "openLive";
  const header = isOpen
    ? `
      <thead>
        <tr>
          <th class="sticky-col">Sembol</th>
          <th class="left">Alış Tarihi</th>
          <th>Maliyet</th>
          <th>Adet</th>
          <th>Tutar</th>
          <th>Canlı Fiyat</th>
          <th>Günlük %</th>
          <th>Değer</th>
          <th>P/L (Canlı)</th>
          <th>P/L %</th>
          <th>Zarar Durdur</th>
          <th>Kâr Al</th>
          <th class="left">Durum</th>
          <th class="left">Not</th>
        </tr>
      </thead>
    `
    : `
      <thead>
        <tr>
          <th class="sticky-col">Sembol</th>
          <th class="left">Alış - Satış</th>
          <th>Maliyet</th>
          <th class="left">Durum</th>
          <th>Adet</th>
          <th>Tutar</th>
          <th>Getiri</th>
          <th>Getiri %</th>
          <th>Zarar Durdur</th>
          <th>Kar Al</th>
          <th class="center">Son Durumu</th>
          <th class="left">Not</th>
        </tr>
      </thead>
    `;

  if (!items.length) {
    const colspan = isOpen ? 13 : 11;
    return (
      header +
      `
      <tbody>
        <tr>
          <th class="sticky-col">${NA}</th>
          <td class="unavailable" colspan="${colspan}">Kriterlere uyan pozisyon yok.</td>
        </tr>
      </tbody>
    `
    );
  }

  const rows = items
    .map((p) => {
      const qty = approxQuantity(p.total, p.unitCost);
      const buy = formatDateTR(p.buyDate);
      const dateRange = `${buy} - ${p.sellDate ? formatDateTR(p.sellDate) : ""}`.trim();
      const outcome = outcomeLabel(p);
      const outcomeCls = outcomeClass(outcome);
      const note = p.notes ?? NA;

      const symbol = String(p.symbol ?? NA);
      const quote = STATE.quotes?.[symbol];
      const livePrice = Number(quote?.price);
      const liveChangePct = Number(quote?.changePct);
      const liveChangePctRounded = round2(liveChangePct);
      const liveValue = qty != null && Number.isFinite(livePrice) ? qty * livePrice : null;
      const unitCost = Number(p?.unitCost);
      const unrealTL =
        qty != null && Number.isFinite(livePrice) && Number.isFinite(unitCost) ? qty * (livePrice - unitCost) : null;
      const unrealPct =
        Number.isFinite(livePrice) && Number.isFinite(unitCost) && unitCost !== 0
          ? ((livePrice / unitCost) - 1) * 100
          : null;

      const changeCls = signedClass(liveChangePct);
      const unrealTLCls = signedClass(unrealTL);
      const unrealPctCls = signedClass(unrealPct);

      if (isOpen) {
        const prevLiveChange = STATE.ui.lastLiveChangePctBySymbol[symbol];
        const flashCls =
          Number.isFinite(prevLiveChange) &&
          Number.isFinite(liveChangePctRounded) &&
          prevLiveChange !== liveChangePctRounded
            ? liveChangePctRounded > prevLiveChange
              ? "flash-up"
              : "flash-down"
            : "";
        STATE.ui.lastLiveChangePctBySymbol[symbol] = liveChangePctRounded;

        return `
          <tr>
            <th class="sticky-col">${escapeHTML(symbol)}</th>
            <td class="left cell-muted">${escapeHTML(buy)}</td>
            <td>${escapeHTML(formatTL(p.unitCost))}</td>
            <td class="cell-muted">${escapeHTML(qty == null ? NA : String(qty))}</td>
            <td>${escapeHTML(formatTL(p.total))}</td>
            <td>${escapeHTML(Number.isFinite(livePrice) ? formatTL(livePrice) : NA)}</td>
            <td class="cell ${changeCls}${flashCls ? ` ${flashCls}` : ""}">${escapeHTML(
              Number.isFinite(liveChangePct) ? formatSignedPct(liveChangePct) : NA
            )}</td>
            <td>${escapeHTML(liveValue == null ? NA : formatTL(liveValue))}</td>
            <td class="cell ${unrealTLCls}">${escapeHTML(unrealTL == null ? NA : formatSignedTL(unrealTL))}</td>
            <td class="cell ${unrealPctCls}">${escapeHTML(unrealPct == null ? NA : formatSignedPct(unrealPct))}</td>
            <td>${escapeHTML(formatTL(p.stopLoss))}</td>
            <td>${escapeHTML(formatTL(p.takeProfit))}</td>
            <td class="left">${escapeHTML(p.status ?? NA)}</td>
            <td class="unavailable left">${escapeHTML(note)}</td>
          </tr>
        `;
      }

      const { pnlTL, pnlPct } = calcPnL(p, exitPriceFromOutcome(p));
      const pnlCls = signedClass(pnlTL, { nanClass: "" });

      return `
        <tr>
          <th class="sticky-col">${escapeHTML(symbol)}</th>
          <td class="left">${escapeHTML(dateRange)}</td>
          <td>${escapeHTML(formatTL(p.unitCost))}</td>
          <td class="left">${escapeHTML(p.status ?? NA)}</td>
          <td>${escapeHTML(qty == null ? NA : String(qty))}</td>
          <td>${escapeHTML(formatTL(p.total))}</td>
          <td class="cell ${pnlCls}">${escapeHTML(pnlTL == null ? NA : formatSignedTL(pnlTL))}</td>
          <td class="cell ${pnlCls}">${escapeHTML(pnlPct == null ? NA : formatSignedPct(pnlPct))}</td>
          <td>${escapeHTML(formatTL(p.stopLoss))}</td>
          <td>${escapeHTML(formatTL(p.takeProfit))}</td>
          <td class="cell ${outcomeCls} center">${escapeHTML(outcome)}</td>
          <td class="unavailable left">${escapeHTML(note)}</td>
        </tr>
      `;
    })
    .join("");

  return `${header}<tbody>${rows}</tbody>`;
}

function activeFiltersSnapshot() {
  const q = String(document.getElementById("q")?.value ?? "").trim();
  const status = String(document.getElementById("status")?.value ?? "").trim();
  const outcome = String(document.getElementById("outcome")?.value ?? "").trim();
  return { q, status, outcome };
}

function computePdfSummaryStats(positions) {
  const list = Array.isArray(positions) ? positions : [];
  const open = list.filter((p) => !p.sellDate);
  const closed = list.filter((p) => p.sellDate);

  const activeAgg = open.reduce(
    (acc, p) => {
      const rr = calcRiskReward(p);
      return {
        invested: acc.invested + (Number(rr.invested) || 0),
        riskTL: acc.riskTL + (Number(rr.riskTL) || 0),
        rewardTL: acc.rewardTL + (Number(rr.rewardTL) || 0),
      };
    },
    { invested: 0, riskTL: 0, rewardTL: 0 }
  );

  const activeRiskPct = activeAgg.invested ? (activeAgg.riskTL / activeAgg.invested) * 100 : null;
  const activeRewardPct = activeAgg.invested ? (activeAgg.rewardTL / activeAgg.invested) * 100 : null;
  const activeRR = activeAgg.riskTL > 0 ? activeAgg.rewardTL / activeAgg.riskTL : null;

  const realizedPnL = closed.reduce(
    (acc, p) => {
      const exitP = exitPriceFromOutcome(p);
      if (exitP == null || !Number.isFinite(exitP)) return acc;
      const { pnlTL, invested } = calcPnL(p, exitP);
      return {
        pnlTL: acc.pnlTL + (Number(pnlTL) || 0),
        invested: acc.invested + (Number(invested) || 0),
      };
    },
    { pnlTL: 0, invested: 0 }
  );
  const realizedPct = realizedPnL.invested ? (realizedPnL.pnlTL / realizedPnL.invested) * 100 : null;

  const closedClassified = closed
    .map((p) => outcomeLabel(p))
    .filter((x) => x === OUTCOME.good || x === OUTCOME.bad);
  const wins = closedClassified.filter((x) => x === OUTCOME.good).length;
  const losses = closedClassified.filter((x) => x === OUTCOME.bad).length;
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : null;

  const liveAgg = open.reduce(
    (acc, p) => {
      const quote = STATE.quotes?.[String(p.symbol ?? "")];
      const price = Number(quote?.price);
      const changeAbs = Number(quote?.changeAbs);
      const qty = approxQuantity(p?.total, p?.unitCost);
      const unitCost = Number(p?.unitCost);

      if (qty == null || !Number.isFinite(unitCost) || !Number.isFinite(price)) return acc;

      const marketValue = qty * price;
      const unreal = qty * (price - unitCost);
      const day = Number.isFinite(changeAbs) ? qty * changeAbs : null;

      return {
        marketValue: acc.marketValue + marketValue,
        unrealized: acc.unrealized + unreal,
        dayChange: acc.dayChange + (Number(day) || 0),
        priced: acc.priced + 1,
      };
    },
    { marketValue: 0, unrealized: 0, dayChange: 0, priced: 0 }
  );

  const hasLive = liveAgg.priced > 0;
  const dayBaseValue = hasLive ? liveAgg.marketValue - liveAgg.dayChange : null;
  const dayChangePct = dayBaseValue ? (liveAgg.dayChange / dayBaseValue) * 100 : null;

  return {
    openCount: open.length,
    closedCount: closed.length,
    activeAgg,
    liveAgg,
    hasLive,
    dayChangePct,
    realizedPnL,
    realizedPct,
    winRate,
    activeRiskPct,
    activeRewardPct,
    activeRR,
  };
}

function computePdfDetailedStatsValues(closedPositions) {
  const positions = Array.isArray(closedPositions) ? closedPositions : [];
  const trades = [];

  for (const p of positions) {
    const exit = exitPriceFromOutcome(p);
    const { pnlTL, pnlPct } = calcPnL(p, exit);
    if (pnlTL == null || pnlPct == null) continue;

    const outcome = outcomeLabel(p);
    if (outcome !== OUTCOME.good && outcome !== OUTCOME.bad) continue;

    const buy = parseISODate(p?.buyDate);
    const sell = parseISODate(p?.sellDate);
    const holdDays =
      buy && sell && Number.isFinite(buy.getTime()) && Number.isFinite(sell.getTime()) ? (sell - buy) / 86_400_000 : null;

    trades.push({ pnlTL, pnlPct, outcome, holdDays });
  }

  const n = trades.length;
  const closedCount = positions.length;
  const wins = trades.filter((t) => t.pnlTL > 0);
  const losses = trades.filter((t) => t.pnlTL < 0);
  const breakeven = trades.filter((t) => t.pnlTL === 0);

  const winRate = n ? (wins.length / n) * 100 : null;

  const sum = (arr, pick) => arr.reduce((acc, x) => acc + (Number(pick(x)) || 0), 0);
  const avg = (arr, pick) => (arr.length ? sum(arr, pick) / arr.length : null);

  const totalPnL = n ? sum(trades, (t) => t.pnlTL) : null;
  const totalWins = wins.length ? sum(wins, (t) => t.pnlTL) : 0;
  const totalLossesAbs = losses.length ? Math.abs(sum(losses, (t) => t.pnlTL)) : 0;
  const profitFactor = totalLossesAbs > 0 ? totalWins / totalLossesAbs : totalWins > 0 ? Infinity : null;

  const avgWinPct = avg(wins, (t) => t.pnlPct);
  const avgLossPct = avg(losses, (t) => t.pnlPct);

  const expectancyPct = (() => {
    if (winRate == null) return null;
    const w = winRate / 100;
    const l = 1 - w;
    if (w === 1 && avgWinPct != null) return avgWinPct;
    if (l === 1 && avgLossPct != null) return avgLossPct;
    if (avgWinPct == null || avgLossPct == null) return null;
    return w * avgWinPct + l * avgLossPct;
  })();

  const bestPct = n ? Math.max(...trades.map((t) => t.pnlPct)) : null;
  const worstPct = n ? Math.min(...trades.map((t) => t.pnlPct)) : null;

  const avgHoldDays = avg(trades.filter((t) => t.holdDays != null), (t) => t.holdDays);

  const bySellDate = positions
    .map((p) => {
      const sell = parseISODate(p?.sellDate);
      const exit = exitPriceFromOutcome(p);
      const { pnlTL } = calcPnL(p, exit);
      return { sell, pnlTL };
    })
    .filter((x) => x.sell && x.pnlTL != null)
    .sort((a, b) => a.sell - b.sell);

  let bestWinStreak = 0;
  let bestLossStreak = 0;
  let curWin = 0;
  let curLoss = 0;
  for (const x of bySellDate) {
    if (x.pnlTL > 0) {
      curWin += 1;
      curLoss = 0;
    } else if (x.pnlTL < 0) {
      curLoss += 1;
      curWin = 0;
    } else {
      curWin = 0;
      curLoss = 0;
    }
    if (curWin > bestWinStreak) bestWinStreak = curWin;
    if (curLoss > bestLossStreak) bestLossStreak = curLoss;
  }

  let verdict = "";
  if (!closedCount) verdict = "";
  else if (!n) verdict = "Bu bölüm için değerlendirilebilir kapanış verisi yok. (Kapanan işlemlerde outcome=1/0 ve takeProfit/stopLoss dolu olmalı.)";
  else if (n < 10) verdict = `Veri az (${n} işlem). İstatistiklerin anlamlı olması için daha fazla kapanan işlem gerekir.`;
  else if (wins.length && !losses.length) verdict = "Şu an tüm işlemler kâr görünüyor; veri tek taraflı. Daha fazla kapanış verisiyle tekrar değerlendir.";
  else if (!wins.length && losses.length) verdict = "Şu an tüm işlemler zarar görünüyor; sistem/uygulama tarafında iyileştirme gerekiyor.";
  else if (expectancyPct != null && expectancyPct > 0) verdict = "Bu veri setinde pozitif beklenti var (uzun vadede artı).";
  else if (expectancyPct != null && expectancyPct <= 0) verdict = "Bu veri setinde beklenti nötr/negatif görünüyor; giriş/çıkış ve risk yönetimini gözden geçir.";

  return {
    n,
    winRate,
    totalPnL,
    profitFactor,
    avgWinPct,
    avgLossPct,
    expectancyPct,
    bestPct,
    worstPct,
    avgHoldDays,
    bestWinStreak,
    bestLossStreak,
    breakevenCount: breakeven.length,
    verdict,
  };
}

async function exportPortfolioPDF() {
  if (STATE.ui.exportPdfInFlight) return;
  STATE.ui.exportPdfInFlight = true;

  const btn = el.btnExportPdf;
  const prevText = btn ? String(btn.textContent ?? "") : "";

  try {
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = "PDF hazırlanıyor...";
    }

    const pdfMake = window.pdfMake;
    if (!pdfMake || typeof pdfMake.createPdf !== "function") throw new Error("PDF kütüphanesi (pdfmake) yüklenmedi.");

    const positions = Array.isArray(STATE.filtered) && STATE.filtered.length ? STATE.filtered : Array.isArray(STATE.data?.positions) ? STATE.data.positions : [];
    const open = positions.filter((p) => !p.sellDate);
    const closed = positions.filter((p) => p.sellDate);

    open.sort((a, b) => {
      const da = parseISODate(a.buyDate)?.getTime() ?? 0;
      const db = parseISODate(b.buyDate)?.getTime() ?? 0;
      if (db !== da) return db - da;
      return String(a.symbol).localeCompare(String(b.symbol), "tr");
    });

    closed.sort((a, b) => {
      const da = parseISODate(a.sellDate)?.getTime() ?? 0;
      const db = parseISODate(b.sellDate)?.getTime() ?? 0;
      if (db !== da) return db - da;
      return String(a.symbol).localeCompare(String(b.symbol), "tr");
    });

    const filters = activeFiltersSnapshot();
    const summary = computePdfSummaryStats(positions);

    const detailed = (() => {
      const stats = computePdfDetailedStatsValues(closed);
      return stats;
    })();

    const now = new Date();
    const ts = now.toLocaleString("tr-TR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const filterParts = [];
    if (filters?.q) filterParts.push(`Arama: ${filters.q}`);
    if (filters?.status) filterParts.push(`Durum: ${filters.status}`);
    if (filters?.outcome) filterParts.push(`Son durum: ${filters.outcome}`);

    const liveState = String(STATE.live?.state ?? "idle");
    const liveLine =
      liveState === "ok"
        ? "Canlı veri: açık"
        : liveState === "error"
          ? `Canlı veri: kapalı (${String(STATE.live?.message ?? "").trim() || "hata"})`
          : "Canlı veri: bekleniyor";

    const kv = (k, v) => [{ text: String(k), style: "kvKey" }, { text: String(v ?? NA), style: "kvVal" }];

    const money = (x) => (x == null ? NA : formatTL(x));
    const smoney = (x) => (x == null ? NA : formatSignedTL(x));
    const spct = (x) => (x == null ? NA : formatSignedPct(x));

    const THEME = {
      ink: "#0f172a",
      muted: "#475569",
      line: "#e2e8f0",
      soft: "#f8fafc",
      headerFill: "#eef2ff",
      zebra: "#fbfdff",
      accent: "#ff0000",
      good: "#0f766e",
      bad: "#b91c1c",
    };

    const signedColorFor = (val) => {
      const s = String(val ?? "").trim();
      if (s.startsWith("+")) return THEME.good;
      if (s.startsWith("-")) return THEME.bad;
      return THEME.ink;
    };

    const th = (text, { alignment = "left" } = {}) => ({ text: String(text), style: "th", alignment });
    const td = (text, { alignment = "left", color, style } = {}) => ({
      text: String(text ?? NA),
      alignment,
      color: color ?? THEME.ink,
      style,
    });
    const tdSigned = (text, { alignment = "right", style } = {}) =>
      td(text, { alignment, style, color: signedColorFor(text) });

    const outcomeColorFor = (label) => {
      if (label === OUTCOME.good) return THEME.good;
      if (label === OUTCOME.bad) return THEME.bad;
      return THEME.ink;
    };

    const kvRow = (k, v, { signed } = {}) => [
      { text: String(k), style: "kvKey" },
      {
        text: String(v ?? NA),
        style: "kvVal",
        alignment: "right",
        color: signed ? signedColorFor(v) : THEME.ink,
      },
    ];

    const layoutCard = {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.8 : 0),
      vLineWidth: (i, node) => (i === 0 || i === node.table.widths.length ? 0.8 : 0),
      hLineColor: () => THEME.line,
      vLineColor: () => THEME.line,
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => 8,
      paddingBottom: () => 8,
      fillColor: () => THEME.soft,
    };

    const layoutTable = {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.8 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => THEME.line,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 4,
      paddingBottom: () => 4,
      fillColor: (rowIndex) => {
        if (rowIndex === 0) return THEME.headerFill;
        return rowIndex % 2 ? THEME.zebra : null;
      },
    };

    const layoutKeyValue = {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.8 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => THEME.line,
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 5,
      paddingBottom: () => 5,
      fillColor: (rowIndex) => (rowIndex % 2 ? THEME.zebra : null),
    };

    const summaryRows = [
      kv("Oluşturma", ts),
      kv("Para birimi", getCurrency()),
      kv("Pozisyon", String(positions.length)),
      kv("Açık / Kapalı", `${open.length} / ${closed.length}`),
      kv("Filtre", filterParts.length ? filterParts.join(" | ") : "-"),
      kv("Canlı", liveLine),
    ];

    const metricsRows = [
      ["Aktif Tutar", money(summary.activeAgg.invested)],
      ["Toplam Risk (SL)", smoney(-summary.activeAgg.riskTL)],
      ["Risk Oranı", spct(summary.activeRiskPct == null ? null : -summary.activeRiskPct)],
      ["Potansiyel (TP)", smoney(summary.activeAgg.rewardTL)],
      ["Pot. Getiri", spct(summary.activeRewardPct)],
      ["Risk/Ödül", summary.activeRR == null || !Number.isFinite(summary.activeRR) ? NA : String(Math.round(summary.activeRR * 100) / 100)],
      ["Canlı Değer", summary.hasLive ? money(summary.liveAgg.marketValue) : NA],
      ["Canlı P/L", summary.hasLive ? smoney(summary.liveAgg.unrealized) : NA],
      ["Günlük P/L", summary.hasLive ? smoney(summary.liveAgg.dayChange) : NA],
      ["Günlük Getiri", summary.hasLive ? spct(summary.dayChangePct) : NA],
      ["Gerçekleşen P/L", smoney(summary.realizedPnL.pnlTL)],
      ["Gerçekleşen Getiri", spct(summary.realizedPct)],
      ["Kazanma Oranı", formatPct(summary.winRate)],
    ];

    const openBody = [
      [
        th("Sembol"),
        th("Alış"),
        th("Maliyet", { alignment: "right" }),
        th("Adet", { alignment: "right" }),
        th("Tutar", { alignment: "right" }),
        th("Canlı", { alignment: "right" }),
        th("Gün %", { alignment: "right" }),
        th("Değer", { alignment: "right" }),
        th("P/L", { alignment: "right" }),
        th("P/L %", { alignment: "right" }),
        th("SL", { alignment: "right" }),
        th("TP", { alignment: "right" }),
        th("Durum"),
        th("Not"),
      ],
    ];

    for (const p of open) {
      const symbol = String(p?.symbol ?? NA);
      const qty = approxQuantity(p?.total, p?.unitCost);
      const quote = STATE.quotes?.[symbol];
      const livePrice = Number(quote?.price);
      const liveChangePct = Number(quote?.changePct);
      const unitCost = Number(p?.unitCost);
      const liveValue = qty != null && Number.isFinite(livePrice) ? qty * livePrice : null;
      const pnlTL = qty != null && Number.isFinite(livePrice) && Number.isFinite(unitCost) ? qty * (livePrice - unitCost) : null;
      const pnlPct = Number.isFinite(livePrice) && Number.isFinite(unitCost) && unitCost !== 0 ? ((livePrice / unitCost) - 1) * 100 : null;

      openBody.push([
        td(symbol, { style: "tdSymbol" }),
        td(formatDateTR(p?.buyDate)),
        td(formatTL(p?.unitCost), { alignment: "right" }),
        td(qty == null ? NA : String(qty), { alignment: "right" }),
        td(formatTL(p?.total), { alignment: "right" }),
        td(Number.isFinite(livePrice) ? formatTL(livePrice) : NA, { alignment: "right" }),
        tdSigned(Number.isFinite(liveChangePct) ? formatSignedPct(liveChangePct) : NA, { alignment: "right" }),
        td(liveValue == null ? NA : formatTL(liveValue), { alignment: "right" }),
        tdSigned(pnlTL == null ? NA : formatSignedTL(pnlTL), { alignment: "right" }),
        tdSigned(pnlPct == null ? NA : formatSignedPct(pnlPct), { alignment: "right" }),
        td(formatTL(p?.stopLoss), { alignment: "right" }),
        td(formatTL(p?.takeProfit), { alignment: "right" }),
        td(String(p?.status ?? NA)),
        td(String(p?.notes ?? ""), { style: "tdNote" }),
      ]);
    }

    const closedBody = [
      [
        th("Sembol"),
        th("Alış"),
        th("Satış"),
        th("Maliyet", { alignment: "right" }),
        th("Adet", { alignment: "right" }),
        th("Tutar", { alignment: "right" }),
        th("Çıkış", { alignment: "right" }),
        th("Son durum"),
        th("P/L", { alignment: "right" }),
        th("P/L %", { alignment: "right" }),
        th("SL", { alignment: "right" }),
        th("TP", { alignment: "right" }),
        th("Durum"),
        th("Not"),
      ],
    ];

    for (const p of closed) {
      const symbol = String(p?.symbol ?? NA);
      const qty = approxQuantity(p?.total, p?.unitCost);
      const exit = exitPriceFromOutcome(p);
      const { pnlTL, pnlPct } = calcPnL(p, exit);
      const outcome = outcomeLabel(p);
      closedBody.push([
        td(symbol, { style: "tdSymbol" }),
        td(formatDateTR(p?.buyDate)),
        td(formatDateTR(p?.sellDate)),
        td(formatTL(p?.unitCost), { alignment: "right" }),
        td(qty == null ? NA : String(qty), { alignment: "right" }),
        td(formatTL(p?.total), { alignment: "right" }),
        td(exit == null ? NA : formatTL(exit), { alignment: "right" }),
        td(outcome, { style: "tdOutcome", color: outcomeColorFor(outcome) }),
        tdSigned(pnlTL == null ? NA : formatSignedTL(pnlTL), { alignment: "right" }),
        tdSigned(pnlPct == null ? NA : formatSignedPct(pnlPct), { alignment: "right" }),
        td(formatTL(p?.stopLoss), { alignment: "right" }),
        td(formatTL(p?.takeProfit), { alignment: "right" }),
        td(String(p?.status ?? NA)),
        td(String(p?.notes ?? ""), { style: "tdNote" }),
      ]);
    }

    const detailedRows = [
      ["İşlem (değerlendirilebilir)", String(detailed.n)],
      ["Kazanma oranı", detailed.winRate == null ? NA : formatPct(detailed.winRate)],
      ["Net P/L", detailed.totalPnL == null ? NA : formatSignedTL(detailed.totalPnL)],
      ["Profit Factor", detailed.profitFactor == null ? NA : detailed.profitFactor === Infinity ? "∞" : String(Math.round(detailed.profitFactor * 100) / 100)],
      ["Ort. Kazanç %", detailed.avgWinPct == null ? NA : formatSignedPct(detailed.avgWinPct)],
      ["Ort. Kayıp %", detailed.avgLossPct == null ? NA : formatSignedPct(detailed.avgLossPct)],
      ["Beklenti %/işlem", detailed.expectancyPct == null ? NA : formatSignedPct(detailed.expectancyPct)],
      ["En iyi / En kötü %", detailed.bestPct == null || detailed.worstPct == null ? NA : `${formatSignedPct(detailed.bestPct)} / ${formatSignedPct(detailed.worstPct)}`],
      ["Seri (W/L)", detailed.n ? `${detailed.bestWinStreak}/${detailed.bestLossStreak}` : NA],
      ["Ort. Süre (gün)", detailed.avgHoldDays == null ? NA : String(Math.round(detailed.avgHoldDays * 10) / 10)],
      ["Breakeven", String(detailed.breakevenCount)],
    ];

const PDF_LOGO_SVG_FALLBACK = `<svg xmlns="http://www.w3.org/2000/svg" width="700.376" height="222" viewBox="0 0 700.376 222">
  <g id="pdflogo" transform="translate(-211.624 -281)">
    <text id="Finance" transform="translate(337 427)" font-size="152" font-family="Helvetica-Bold, Helvetica" font-weight="700"><tspan x="0" y="0">Finance</tspan></text>
    <path id="daisy" d="M95.571,42.072l-20.3,3.944L92.414,34.453A12.556,12.556,0,1,0,74.719,16.758L63.106,34.153,67.1,13.6a12.557,12.557,0,1,0-25.028,0l4.089,20.515L34.453,16.758a12.555,12.555,0,0,0-18.464-.769h0a12.555,12.555,0,0,0,.769,18.464L34.153,46.066,13.6,42.072A12.559,12.559,0,0,0,0,54.586H0A12.557,12.557,0,0,0,13.6,67.1l20.77-4.139L16.758,74.719a12.555,12.555,0,0,0-.769,18.464h0a12.555,12.555,0,0,0,18.464-.769L46.162,75.056,42.072,95.571a12.557,12.557,0,1,0,25.028,0L63.106,75.019,74.719,92.414A12.556,12.556,0,1,0,92.414,74.719L75.056,63.01,95.571,67.1a12.559,12.559,0,0,0,13.6-12.514h0a12.557,12.557,0,0,0-13.6-12.514ZM54.586,65.958A11.372,11.372,0,1,1,65.958,54.586,11.37,11.37,0,0,1,54.586,65.958Z" transform="translate(211.624 318)"/>
    <text id="PortfБy" transform="translate(907 493)" font-size="46" font-family="Helvetica"><tspan x="-145.727" y="0">PortfБy</tspan></text>
  </g>
</svg>`;

    const PDF_CLOSE_SVG_FALLBACK = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1920" height="1080.38" viewBox="0 0 1920 1080.38">
  <defs>
    <clipPath id="clip-path">
      <rect y="-185" width="1788.759" height="1079.759" fill="none"/>
    </clipPath>
  </defs>
  <g id="pdfclose" transform="translate(0)">
    <g id="Scroll_Group_1" data-name="Scroll Group 1" transform="translate(65.62 185.62)" clip-path="url(#clip-path)" style="isolation: isolate">
      <path id="daisy" d="M1565.91,689.343l-332.635,64.619L1514.185,564.5c91.9-77.736,97.711-217.409,12.6-302.524s-224.787-79.3-302.524,12.6L1033.978,559.583l65.439-336.734C1109.4,102.928,1014.749,0,894.38,0S679.356,102.854,689.343,222.85l67,336.138L564.5,274.575c-77.736-91.9-217.409-97.711-302.524-12.6h0c-85.115,85.115-79.3,224.787,12.6,302.524L559.584,754.782,222.85,689.343C102.928,679.356,0,774.011,0,894.38H0c0,120.368,102.854,215.024,222.85,205.036l340.311-67.824L274.575,1224.257c-91.9,77.736-97.711,217.409-12.6,302.524h0c85.115,85.115,224.787,79.3,302.524-12.6l191.844-284.413-67,336.138c-9.987,119.921,84.668,222.85,205.037,222.85s215.024-102.854,205.036-222.85l-65.439-336.734,190.279,285.009c77.736,91.9,217.409,97.711,302.524,12.6s79.3-224.788-12.6-302.524l-284.413-191.844,336.138,67c119.921,9.987,222.85-84.668,222.85-205.036h0c0-120.369-102.854-215.024-222.85-205.037ZM894.38,1080.709A186.329,186.329,0,1,1,1080.709,894.38,186.3,186.3,0,0,1,894.38,1080.709Z" fill="#616161" opacity="0.05"/>
    </g>
    <g id="pdflogo" transform="translate(398.688 154.25)">
      <text id="Finance" transform="translate(337.312 427)" fill="#003cff" font-size="152" font-family="Helvetica-Bold, Helvetica" font-weight="700"><tspan x="0" y="0">Finance</tspan></text>
      <text id="portfoy.openwall.com.tr" transform="translate(530.312 482.5)" fill="#1d1d1f" font-size="36" font-family="Helvetica"><tspan x="0" y="0">portfoy.</tspan><tspan y="0" font-family="Helvetica-Bold, Helvetica" font-weight="700">openwall</tspan><tspan y="0">.com.tr</tspan></text>
      <path id="daisy-2" data-name="daisy" d="M95.571,42.072l-20.3,3.944L92.414,34.453A12.556,12.556,0,1,0,74.719,16.758L63.106,34.153,67.1,13.6a12.557,12.557,0,1,0-25.028,0l4.089,20.515L34.453,16.758a12.555,12.555,0,0,0-18.464-.769h0a12.555,12.555,0,0,0,.769,18.464L34.153,46.066,13.6,42.072A12.559,12.559,0,0,0,0,54.586H0A12.557,12.557,0,0,0,13.6,67.1l20.77-4.139L16.758,74.719a12.555,12.555,0,0,0-.769,18.464h0a12.555,12.555,0,0,0,18.464-.769L46.162,75.056,42.072,95.571a12.557,12.557,0,1,0,25.028,0L63.106,75.019,74.719,92.414A12.556,12.556,0,1,0,92.414,74.719L75.056,63.01,95.571,67.1a12.559,12.559,0,0,0,13.6-12.514h0a12.557,12.557,0,0,0-13.6-12.514ZM54.586,65.958A11.372,11.372,0,1,1,65.958,54.586,11.37,11.37,0,0,1,54.586,65.958Z" transform="translate(211.624 318)" fill="#003cff"/>
    </g>
    <g id="Group_2" data-name="Group 2">
      <rect id="Rectangle_1" data-name="Rectangle 1" width="9" height="29" fill="#003bfb"/>
      <rect id="Rectangle_2" data-name="Rectangle 2" width="9" height="29" transform="translate(29) rotate(90)" fill="#003bfb"/>
    </g>
    <g id="Group_1" data-name="Group 1" transform="translate(-97 1117) rotate(-90)">
      <rect id="Rectangle_3" data-name="Rectangle 3" width="9" height="29" transform="translate(37 97)" fill="#003bfb"/>
      <rect id="Rectangle_4" data-name="Rectangle 4" width="9" height="29" transform="translate(66 97) rotate(90)" fill="#003bfb"/>
    </g>
    <g id="Group_3" data-name="Group 3" transform="translate(2017 -37) rotate(90)">
      <rect id="Rectangle_3-2" data-name="Rectangle 3" width="9" height="29" transform="translate(37 97)" fill="#003bfb"/>
      <rect id="Rectangle_4-2" data-name="Rectangle 4" width="9" height="29" transform="translate(66 97) rotate(90)" fill="#003bfb"/>
    </g>
    <g id="Group_4" data-name="Group 4" transform="translate(1957 1177) rotate(180)">
      <rect id="Rectangle_3-3" data-name="Rectangle 3" width="9" height="29" transform="translate(37 97)" fill="#003bfb"/>
      <rect id="Rectangle_4-3" data-name="Rectangle 4" width="9" height="29" transform="translate(66 97) rotate(90)" fill="#003bfb"/>
    </g>
  </g>
</svg>`;

    const loadSvgText = async (url) => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return null;
        const text = await res.text();
        return typeof text === "string" && text.includes("<svg") ? text : null;
      } catch {
        return null;
      }
    };

    const sanitizeSvgForPdf = (svgText) => {
      let s = String(svgText ?? "");
      s = s.replace(/\sxmlns:xlink=(\"[^\"]*\"|'[^']*')/gi, "");
      s = s.replace(/<defs[\s\S]*?<\/defs>/gi, "");
      s = s.replace(/\sclip-path=(\"[^\"]*\"|'[^']*')/gi, "");
      s = s.replace(/\sstyle=(\"isolation:\s*isolate\"|'isolation:\s*isolate')/gi, "");
      return s;
    };

    const ensureSvgOpacity = (svgText, opacity) => {
      const s = String(svgText ?? "");
      return s.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
        if (/\sopacity\s*=/.test(attrs)) return m;
        return `<svg${attrs} opacity="${opacity}">`;
      });
    };

    const logoSvg = sanitizeSvgForPdf((await loadSvgText("assets/pdflogo.svg")) ?? PDF_LOGO_SVG_FALLBACK);
    const closeSvg = sanitizeSvgForPdf((await loadSvgText("assets/pdfclose.svg")) ?? PDF_CLOSE_SVG_FALLBACK);
    const watermarkSvgRaw = sanitizeSvgForPdf(await loadSvgText("assets/watermark.svg"));
    const watermarkSvg = watermarkSvgRaw ? ensureSvgOpacity(watermarkSvgRaw, 0.035) : null;
    const hasClosePage = !!closeSvg;
    const reportId = `SWP-${todayKey()}-${String(now.getTime()).slice(-6)}`;
    const reportOwner = String(STATE.data?.owner ?? STATE.data?.ownerName ?? "").trim();
    const ownerLine = reportOwner ? `${reportOwner} adına hazırlanmıştır.` : "Kişisel kullanım için hazırlanmıştır.";

    const docDefinition = {
      pageSize: "A4",
      pageMargins: [28, 62, 28, 44],
      info: { title: "Portföy Raporu", author: "SWPort", subject: "Portföy Raporu" },
      defaultStyle: { font: "Roboto", fontSize: 10, color: THEME.ink },
      styles: {
        title: { fontSize: 18, bold: true, color: THEME.ink },
        subtitle: { fontSize: 10, color: THEME.muted },
        h2: { fontSize: 11, bold: true, color: THEME.ink, margin: [0, 14, 0, 6] },
        th: { bold: true, fontSize: 8, color: THEME.ink },
        kvKey: { bold: true, fontSize: 9, color: THEME.muted },
        kvVal: { fontSize: 9, color: THEME.ink },
        small: { fontSize: 8, color: THEME.muted },
        mono: { fontSize: 7, color: THEME.ink },
        tdSymbol: { bold: true },
        tdOutcome: { bold: true },
        tdNote: { fontSize: 7, color: THEME.muted },
      },
      background: (currentPage, pageSize) => ({
        stack: [
          currentPage !== 1
            ? {
                canvas: [
                  { type: "rect", x: 0, y: 0, w: pageSize.width, h: 52, color: THEME.soft },
                  { type: "rect", x: 0, y: 52, w: pageSize.width, h: 1, color: THEME.line },
                  { type: "rect", x: 0, y: 52, w: 150, h: 2, color: THEME.accent },
                ],
              }
            : null,
          watermarkSvg
            ? {
                svg: watermarkSvg,
                width: 520,
                absolutePosition: { x: Math.round(pageSize.width / 2 - 260), y: Math.round(pageSize.height / 2 - 260) },
              }
            : null,
        ].filter(Boolean),
      }),
      header: (currentPage, pageCount) => {
        if (currentPage === 1) return null;
        if (hasClosePage && currentPage === pageCount) return null;
        return {
          margin: [28, 16, 28, 0],
          columns: [
            logoSvg ? { svg: logoSvg, width: 78 } : { text: "Openwall Finance", style: "subtitle" },
            {
              width: "*",
              stack: [
                { text: "PORTFÖY RAPORU", style: "subtitle", alignment: "right" },
                { text: `Rapor No: ${reportId}`, style: "small", alignment: "right" },
              ],
            },
          ],
        };
      },
      footer: (currentPage, pageCount) => {
        if (hasClosePage && currentPage === pageCount) return null;
        return {
          margin: [28, 0, 28, 18],
          columns: [
            { text: `Oluşturma: ${ts}`, style: "small" },
            { text: "Otomatik olarak oluşturulmuştur.", style: "small", alignment: "center" },
            { text: `Sayfa ${currentPage}/${pageCount}`, alignment: "right", style: "small" },
          ],
        };
      },
      content: [
        {
          columns: [
            logoSvg ? { svg: logoSvg, width: 140 } : { text: "", width: 140 },
            {
              width: "*",
              stack: [
                { text: "Portföy Raporu", style: "title", alignment: "right" },
                { text: ownerLine, style: "subtitle", alignment: "right" },
              ],
            },
          ],
          columnGap: 12,
          margin: [0, 0, 0, 8],
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 786, y2: 0, lineWidth: 1, lineColor: THEME.line }], margin: [0, 4, 0, 10] },
        { text: "Rapor Bilgileri", style: "h2" },
        {
          table: {
            widths: ["*"],
            body: [
              [
                {
                  table: { widths: ["auto", "*"], body: summaryRows },
                  layout: "noBorders",
                },
              ],
            ],
          },
          layout: layoutCard,
        },
        { text: "Güncel", style: "h2" },
        {
          table: {
            widths: ["auto", "*"],
            body: metricsRows.map(([k, v]) => kvRow(k, v, { signed: true })),
          },
          layout: layoutKeyValue,
        },
        { text: "Gerçekleşmiş", style: "h2" },
        {
          table: { widths: ["auto", "*"], body: detailedRows.map(([k, v]) => kvRow(k, v, { signed: true })) },
          layout: layoutKeyValue,
        },
        detailed.verdict ? { text: detailed.verdict, style: "small", margin: [0, 6, 0, 0] } : null,
        { text: "Açık Pozisyonlar", style: "h2", pageBreak: "before" },
        {
          table: {
            headerRows: 1,
            widths: [40, 44, 44, 32, 40, 40, 34, 40, 40, 34, 32, 32, 46, "*"],
            body: openBody,
          },
          layout: layoutTable,
          fontSize: 8,
        },
        { text: "Kapalı Pozisyonlar", style: "h2" },
        {
          table: {
            headerRows: 1,
            widths: [40, 44, 44, 44, 32, 40, 36, 44, 40, 34, 32, 32, 46, "*"],
            body: closedBody,
          },
          layout: layoutTable,
          fontSize: 8,
        },
        {
          text: "Not: Bu rapor bilgilendirme amaçlıdır; yatırım tavsiyesi değildir.",
          style: "small",
          margin: [0, 10, 0, 0],
        },
        closeSvg
          ? {
              pageBreak: "before",
              stack: [
                {
                  canvas: [{ type: "rect", x: 0, y: 0, w: 2000, h: 2000, color: "#ffffff" }],
                  absolutePosition: { x: 0, y: 0 },
                },
                {
                  svg: closeSvg,
                  absolutePosition: { x: -108, y: 0 },
                  width: 1058,
                },
              ],
            }
          : null,
      ].filter(Boolean),
      pageOrientation: "landscape",
    };

    pdfMake.createPdf(docDefinition).download(`Openwall-Portföy-${todayKey()}.pdf`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (el.notice) {
      el.notice.innerHTML = `<div class="empty"><div>PDF oluşturulamadı.</div><div class="subtle" style="margin-top:8px">${escapeHTML(
        msg
      )}</div></div>`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.textContent = prevText || "PDF İndir";
    }

    STATE.ui.exportPdfInFlight = false;
  }
}

function applyFilters() {
  const qEl = document.getElementById("q");
  const statusEl = document.getElementById("status");
  const outcomeEl = document.getElementById("outcome");

  const q = normalize(qEl?.value ?? "").trim();
  const status = statusEl?.value ?? "";
  const outcome = outcomeEl?.value ?? "";

  const positions = STATE.data?.positions ?? [];
  const filtered = positions.filter((p) => {
    if (status && p.status !== status) return false;
    if (outcome && outcomeLabel(p) !== outcome) return false;
    if (q) {
      const hay = normalize(`${p.symbol} ${p.notes ?? ""} ${p.status ?? ""} ${outcomeLabel(p)} ${p.outcome ?? ""}`);
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  STATE.filtered = filtered;
  buildSummary(filtered);
  renderTables(filtered);
}

async function loadData() {
  const res = await fetch("data/portfolio.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Veri okunamadı: ${res.status}`);
  return res.json();
}

function loadFromLocalFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Dosya okunamadı."));
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result ?? "")));
      } catch {
        reject(new Error("JSON parse edilemedi."));
      }
    };
    reader.readAsText(file);
  });
}

function wire() {
  if (STATE.ui.wired) return;
  const filterEls = [document.getElementById("q"), document.getElementById("status"), document.getElementById("outcome")].filter(
    Boolean
  );
  for (const input of filterEls) {
    input.addEventListener("input", applyFilters);
    input.addEventListener("change", applyFilters);
  }

  if (el.btnExportPdf) {
    el.btnExportPdf.addEventListener("click", () => exportPortfolioPDF());
  }

  if (el.mainTabs) {
    el.mainTabs.addEventListener("click", (e) => {
      const btn = e.target?.closest?.('button[role="tab"][data-tab]');
      if (!btn) return;
      setMainTab(btn.dataset.tab);
    });

    el.mainTabs.addEventListener("keydown", (e) => {
      const tab = e.target?.closest?.('button[role="tab"][data-tab]');
      if (!tab) return;

      const tabs = Array.from(el.mainTabs.querySelectorAll('button[role="tab"][data-tab]'));
      const i = tabs.indexOf(tab);
      if (i < 0) return;

      let nextIndex = null;
      if (e.key === "ArrowRight") nextIndex = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") nextIndex = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") nextIndex = 0;
      else if (e.key === "End") nextIndex = tabs.length - 1;
      else return;

      e.preventDefault();
      const nextTab = tabs[nextIndex];
      setMainTab(nextTab.dataset.tab);
      nextTab.focus();
    });
  }

  setMainTab(STATE.ui.mainTab);
  window.addEventListener("resize", () => syncMainTabIndicator());

  STATE.ui.wired = true;
}

function updateLiveStatus() {
  if (!el.liveStatus) return;
  const state = STATE.live?.state ?? "idle";
  const message = STATE.live?.message ?? "";
  const lastUpdated = STATE.live?.lastUpdated;
  const sourceAsOf = STATE.live?.sourceAsOf;

  const dotClass = state === "ok" ? "good" : state === "error" ? "bad" : "warn";
  const time =
    lastUpdated instanceof Date && Number.isFinite(lastUpdated.getTime())
      ? lastUpdated.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
      : null;
  const sourceTime =
    sourceAsOf instanceof Date && Number.isFinite(sourceAsOf.getTime())
      ? sourceAsOf.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
      : null;

  let text =
    state === "ok"
      ? `Canlı: Açık${time ? ` · ${time}` : ""}`
      : state === "error"
        ? `Canlı: Kapalı${message ? ` · ${message}` : ""}`
        : "Canlı: Bekleniyor";

  if (state === "ok" && sourceTime) text += ` | Kaynak ${sourceTime}`;

  el.liveStatus.innerHTML = `<span class="dot ${dotClass}" aria-hidden="true"></span><span>${escapeHTML(
    text
  )}</span>`;
}

function updateLiveStatus() {
  if (!el.liveStatus) return;
  const state = STATE.live?.state ?? "idle";
  const message = STATE.live?.message ?? "";
  const lastUpdated = STATE.live?.lastUpdated;
  const sourceAsOf = STATE.live?.sourceAsOf;

  const dotClass = state === "ok" ? "good" : state === "error" ? "bad" : "warn";
  const time =
    lastUpdated instanceof Date && Number.isFinite(lastUpdated.getTime())
      ? lastUpdated.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
      : null;
  const sourceTime =
    sourceAsOf instanceof Date && Number.isFinite(sourceAsOf.getTime())
      ? sourceAsOf.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
      : null;

  let text =
    state === "ok"
      ? `Canlı: Açık${time ? ` • ${time}` : ""}`
      : state === "error"
        ? `Canlı: Kapalı${message ? ` • ${message}` : ""}`
        : "Canlı: Bekleniyor";

  if (state === "ok" && sourceTime) text += ` • Kaynak ${sourceTime}`;

  el.liveStatus.innerHTML = `<span class="dot ${dotClass}" aria-hidden="true"></span><span>${escapeHTML(text)}</span>`;
}

function tickersFromPositions() {
  const positions = Array.isArray(STATE.data?.positions) ? STATE.data.positions : [];
  const set = new Set();
  for (const p of positions) {
    if (p?.sellDate) continue;
    const sym = String(p?.symbol ?? "").trim();
    if (sym) set.add(sym.toUpperCase());
  }
  return Array.from(set);
}

async function refreshQuotes() {
  const refresh = STATE.ui.quotesRefresh;
  if (refresh.inFlight) return;
  refresh.inFlight = true;

  try {
    const tickers = tickersFromPositions();
    if (!tickers.length) return;

    const lastBase =
      typeof STATE.live?.apiBase === "string" && STATE.live.apiBase.trim() ? STATE.live.apiBase.trim() : null;

    const proto = String(window.location?.protocol ?? "");
    const isHttp = proto === "http:" || proto === "https:";

    const bases = Array.from(
      new Set(
        [
          lastBase,
          isHttp ? "" : null,
          "http://127.0.0.1:4173",
          "http://localhost:4173",
          "http://127.0.0.1:8000",
          "http://localhost:8000",
        ].filter((x) => typeof x === "string")
      )
    );

    const prevApiBase = typeof STATE.live?.apiBase === "string" ? STATE.live.apiBase : "";

    let lastErr = null;
    for (const base of bases) {
      try {
        const prefix = base ? base.replace(/\/+$/, "") : "";
        const url = `${prefix}/api/quotes?tickers=${encodeURIComponent(tickers.join(","))}`;

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), QUOTES_FETCH_TIMEOUT_MS);
        let res;
        try {
          res = await fetch(url, { cache: "no-store", signal: controller.signal });
        } finally {
          window.clearTimeout(timeoutId);
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const quotes = json?.quotes && typeof json.quotes === "object" ? json.quotes : {};
        const sourceAsOf = parseISODate(json?.asOf);

        STATE.quotes = quotes;
        STATE.live = { state: "ok", lastUpdated: new Date(), message: "", apiBase: prefix, sourceAsOf };
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (lastErr) {
      const raw = String(lastErr?.message ?? lastErr);
      const errName = typeof lastErr === "object" && lastErr ? String(lastErr.name ?? "") : "";
      const isAbort = errName === "AbortError" || raw.includes("AbortError");

      const msg = isAbort
        ? "Zaman asimi"
        : raw.includes("HTTP 404") || raw.includes("Failed to fetch")
          ? "Sunucu yok"
          : raw.replaceAll("\n", " ").trim();

      STATE.live = {
        state: "error",
        lastUpdated: STATE.live?.lastUpdated ?? null,
        message: msg,
        apiBase: prevApiBase,
        sourceAsOf: STATE.live?.sourceAsOf ?? null,
      };
    }

    applyFilters();
    if (STATE.ui.mainTab === "chart") scheduleChartUpdate(STATE.filtered || []);
  } finally {
    refresh.inFlight = false;
  }
}

function startLiveQuotes() {
  const refresh = STATE.ui.quotesRefresh;
  if (refresh.timerId != null) window.clearTimeout(refresh.timerId);

  const nextDelayMs = () => (STATE.live?.state === "ok" ? QUOTES_REFRESH_OK_MS : QUOTES_REFRESH_ERROR_MS);

  const loop = async () => {
    try {
      await refreshQuotes();
    } finally {
      refresh.timerId = window.setTimeout(loop, nextDelayMs());
    }
  };

  loop();
}

async function main() {
  try {
    STATE.data = await loadData();
  } catch (err) {
    el.notice.innerHTML = `
        <div class="empty">
          <div>Veri yüklenemedi.</div>
          <div class="subtle" style="margin-top:8px">
            Bazı tarayıcılar <code>file://</code> altında JSON <code>fetch</code> isteğini engeller.
            Çözüm: <code>data/portfolio.json</code> dosyasını seç veya bir yerel sunucu ile aç (örn. <code>npx serve</code>).
          </div>
          <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap">
            <input id="pick" type="file" accept=".json,application/json" />
          </div>
        </div>
      `;
    if (el.meta) el.meta.textContent = String(err?.message ?? err);

    const picker = document.getElementById("pick");
    if (picker) {
      picker.addEventListener("change", async () => {
        const file = picker.files?.[0];
        if (!file) return;
        try {
          STATE.data = await loadFromLocalFile(file);
        } catch (e) {
          if (el.meta) el.meta.textContent = String(e?.message ?? e);
          return;
        }

        el.notice.innerHTML = "";
        const positions = Array.isArray(STATE.data.positions) ? STATE.data.positions : [];
        buildSummary(positions);
        renderTables(positions);
        wire();
        applyFilters();
        refreshQuotes();
        if (el.meta) el.meta.textContent = `Dosyadan yüklendi: ${file.name} · Pozisyon: ${positions.length}`;
      });
    }

    return;
  }

  const positions = Array.isArray(STATE.data.positions) ? STATE.data.positions : [];
  wire();
  STATE.filtered = positions;
  applyFilters();
  refreshQuotes();

  const updatedAt = new Date();
  if (el.meta) el.meta.textContent = `Son yükleme: ${updatedAt.toLocaleDateString("tr-TR")} · Pozisyon: ${positions.length}`;
}

main();
startLiveQuotes();

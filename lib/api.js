function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendJSON(res, statusCode, obj) {
  send(
    res,
    statusCode,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    JSON.stringify(obj)
  );
}

function sendOptions(res) {
  return send(res, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
}

function normalizeTickers(raw) {
  const parts = String(raw ?? "")
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const t = p.toUpperCase();
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }

  return out.slice(0, 50);
}

function parseDateKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const ms = Date.UTC(y, mo - 1, d, 0, 0, 0);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function toYahooSymbol(ticker) {
  const raw = String(ticker ?? "").trim();
  if (!raw) return null;
  const t = raw.includes(":") ? raw.split(":").pop() : raw;
  const upper = String(t).toUpperCase();
  if (upper.includes(".")) return upper;
  return `${upper}.IS`;
}

async function fetchYahooHistory(ticker, { startSec, endSec }) {
  if (typeof fetch !== "function") throw new Error("fetch bulunamadi (Node 18+ gerekli)");

  const symbol = toYahooSymbol(ticker);
  if (!symbol) throw new Error("symbol bos");

  const period1 = Number.isFinite(startSec) ? Math.max(0, Math.floor(startSec)) : null;
  const period2 = Number.isFinite(endSec) ? Math.max(0, Math.floor(endSec)) : null;

  const params = new URLSearchParams({
    interval: "1d",
    includeAdjustedClose: "true",
  });

  if (period1 != null && period2 != null) {
    params.set("period1", String(period1));
    params.set("period2", String(period2));
  } else {
    params.set("range", "1y");
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Yahoo HTTP ${resp.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
  }

  const json = await resp.json();
  const result = json?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close) ? result.indicators.quote[0].close : [];
  const adjcloses = Array.isArray(result?.indicators?.adjclose?.[0]?.adjclose) ? result.indicators.adjclose[0].adjclose : [];

  const outT = [];
  const outC = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = Number(timestamps[i]);
    const adj = Number(adjcloses?.[i]);
    const raw = Number.isFinite(adj) ? adj : Number(closes?.[i]);
    const c = raw;
    if (!Number.isFinite(ts) || !Number.isFinite(c)) continue;
    outT.push(ts);
    outC.push(c);
  }

  return {
    ticker: String(ticker).toUpperCase(),
    symbol,
    timestamps: outT,
    close: outC,
    priceType: adjcloses.length ? "adjclose" : "close",
  };
}

async function fetchTradingViewQuotes(tickers) {
  if (typeof fetch !== "function") throw new Error("fetch bulunamadi (Node 18+ gerekli)");

  const tvSymbols = tickers.map((t) => (t.includes(":") ? t : `BIST:${t}`));

  const body = {
    symbols: { tickers: tvSymbols, query: { types: [] } },
    columns: ["close", "change", "change_abs", "volume", "description", "name"],
  };

  const resp = await fetch("https://scanner.tradingview.com/turkey/scan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`TradingView HTTP ${resp.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
  }

  const json = await resp.json();
  const data = Array.isArray(json?.data) ? json.data : [];

  const quotes = {};
  for (const item of data) {
    const tvSymbol = String(item?.s ?? "");
    const parts = tvSymbol.split(":");
    const ticker = (parts[1] ?? tvSymbol).toUpperCase();
    const d = Array.isArray(item?.d) ? item.d : [];

    const [price, changePct, changeAbs, volume, description, name] = d;
    quotes[ticker] = {
      tvSymbol,
      name: typeof name === "string" ? name : null,
      description: typeof description === "string" ? description : null,
      price: Number.isFinite(Number(price)) ? Number(price) : null,
      changePct: Number.isFinite(Number(changePct)) ? Number(changePct) : null,
      changeAbs: Number.isFinite(Number(changeAbs)) ? Number(changeAbs) : null,
      volume: Number.isFinite(Number(volume)) ? Number(volume) : null,
    };
  }

  return {
    source: "tradingview:turkey",
    asOf: new Date().toISOString(),
    quotes,
    total: Object.keys(quotes).length,
    requested: tickers.length,
  };
}

function getSearchParams(req) {
  const url = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`);
  return url.searchParams;
}

async function handleHealth(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return sendJSON(res, 405, { error: "Method not allowed" });
  return sendJSON(res, 200, { ok: true, now: new Date().toISOString() });
}

async function handleQuotes(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return sendJSON(res, 405, { error: "Method not allowed" });

  const qs = getSearchParams(req);
  const tickers = normalizeTickers(qs.get("tickers") || qs.get("symbols") || "");
  if (!tickers.length) return sendJSON(res, 400, { error: "tickers gerekli. Or: /api/quotes?tickers=ALARK,FORTE" });

  try {
    const payload = await fetchTradingViewQuotes(tickers);
    return sendJSON(res, 200, payload);
  } catch (e) {
    return sendJSON(res, 502, { error: String(e?.message ?? e) });
  }
}

async function handleHistory(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (req.method !== "GET") return sendJSON(res, 405, { error: "Method not allowed" });

  const qs = getSearchParams(req);
  const tickers = normalizeTickers(qs.get("tickers") || qs.get("symbols") || "");
  if (!tickers.length) return sendJSON(res, 400, { error: "tickers gerekli." });

  const startKey = qs.get("start");
  const endKey = qs.get("end");
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  const startSec = start != null ? start : null;
  const endSec = end != null ? end + 86400 : null;

  const series = {};
  const errors = {};

  await Promise.all(
    tickers.slice(0, 25).map(async (t) => {
      try {
        const hist = await fetchYahooHistory(t, { startSec, endSec });
        series[t] = { symbol: hist.symbol, timestamps: hist.timestamps, close: hist.close, priceType: hist.priceType };
      } catch (e) {
        errors[t] = String(e?.message ?? e);
      }
    })
  );

  return sendJSON(res, 200, {
    source: "yahoo:chart",
    asOf: new Date().toISOString(),
    start: startKey || null,
    end: endKey || null,
    series,
    errors,
    requested: tickers.length,
    returned: Object.keys(series).length,
  });
}

module.exports = {
  handleHealth,
  handleQuotes,
  handleHistory,
};


import json
import json
import sys
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse


def _send_json(handler: SimpleHTTPRequestHandler, status: int, obj: dict) -> None:
    payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _normalize_tickers(raw: str) -> list[str]:
    parts = [p.strip().upper() for p in raw.replace(" ", ",").split(",") if p.strip()]
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out[:50]


def _parse_date_key(value: str | None) -> int | None:
    if not value:
        return None
    s = str(value).strip()
    try:
        dt = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except Exception:
        return None
    return int(dt.timestamp())


def _to_yahoo_symbol(ticker: str) -> str | None:
    raw = str(ticker or "").strip()
    if not raw:
        return None
    if ":" in raw:
        raw = raw.split(":", 1)[1]
    sym = raw.upper()
    if "." in sym:
        return sym
    return f"{sym}.IS"


def _fetch_yahoo_history(ticker: str, start_sec: int | None, end_sec: int | None) -> dict:
    symbol = _to_yahoo_symbol(ticker)
    if not symbol:
        raise ValueError("symbol boş")

    params: dict[str, str] = {"interval": "1d", "includeAdjustedClose": "true"}
    if start_sec is not None and end_sec is not None:
        params["period1"] = str(max(0, int(start_sec)))
        params["period2"] = str(max(0, int(end_sec)))
    else:
        params["range"] = "1y"

    qs = "&".join([f"{k}={quote(v)}" for k, v in params.items()])
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}?{qs}"

    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        parsed = json.loads(raw)

    result = None
    chart = parsed.get("chart") if isinstance(parsed, dict) else None
    if isinstance(chart, dict):
        res = chart.get("result")
        if isinstance(res, list) and res:
            result = res[0]

    timestamps = result.get("timestamp") if isinstance(result, dict) else None
    indicators = result.get("indicators") if isinstance(result, dict) else None
    quote_arr = indicators.get("quote") if isinstance(indicators, dict) else None
    q0 = quote_arr[0] if isinstance(quote_arr, list) and quote_arr else None
    closes = q0.get("close") if isinstance(q0, dict) else None
    adj_arr = indicators.get("adjclose") if isinstance(indicators, dict) else None
    a0 = adj_arr[0] if isinstance(adj_arr, list) and adj_arr else None
    adjcloses = a0.get("adjclose") if isinstance(a0, dict) else None

    if not isinstance(timestamps, list):
        timestamps = []
    if not isinstance(closes, list):
        closes = []
    if not isinstance(adjcloses, list):
        adjcloses = []

    out_t: list[int] = []
    out_c: list[float] = []
    for i in range(len(timestamps)):
        ts = timestamps[i]
        c = None
        if i < len(adjcloses) and adjcloses[i] is not None:
            c = adjcloses[i]
        elif i < len(closes) and closes[i] is not None:
            c = closes[i]
        try:
            ts_i = int(ts)
            c_f = float(c)
        except Exception:
            continue
        out_t.append(ts_i)
        out_c.append(c_f)

    return {"symbol": symbol, "timestamps": out_t, "close": out_c, "priceType": "adjclose" if len(adjcloses) else "close"}


def _fetch_tradingview_quotes(tickers: list[str]) -> dict:
    tv_symbols = [t if ":" in t else f"BIST:{t}" for t in tickers]
    body = {
        "symbols": {"tickers": tv_symbols, "query": {"types": []}},
        "columns": ["close", "change", "change_abs", "volume", "description", "name"],
    }
    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        "https://scanner.tradingview.com/turkey/scan",
        method="POST",
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )

    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        parsed = json.loads(raw)

    rows = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(rows, list):
        rows = []

    quotes: dict[str, dict] = {}
    for item in rows:
        if not isinstance(item, dict):
            continue
        tv_symbol = str(item.get("s") or "")
        d = item.get("d")
        if not isinstance(d, list):
            d = []

        ticker = tv_symbol.split(":", 1)[1].upper() if ":" in tv_symbol else tv_symbol.upper()

        price = d[0] if len(d) > 0 else None
        change_pct = d[1] if len(d) > 1 else None
        change_abs = d[2] if len(d) > 2 else None
        volume = d[3] if len(d) > 3 else None
        description = d[4] if len(d) > 4 else None
        name = d[5] if len(d) > 5 else None

        def as_num(x):
            try:
                n = float(x)
                return n
            except Exception:
                return None

        quotes[ticker] = {
            "tvSymbol": tv_symbol,
            "name": name if isinstance(name, str) else None,
            "description": description if isinstance(description, str) else None,
            "price": as_num(price),
            "changePct": as_num(change_pct),
            "changeAbs": as_num(change_abs),
            "volume": as_num(volume),
        }

    return {
        "source": "tradingview:turkey",
        "asOf": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "quotes": quotes,
        "total": len(quotes),
        "requested": len(tickers),
    }


class Handler(SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()
            return
        return super().do_OPTIONS()

    def do_GET(self):
        url = urlparse(self.path)

        if url.path == "/api/health":
            return _send_json(self, 200, {"ok": True, "now": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")})

        if url.path == "/api/quotes":
            qs = parse_qs(url.query)
            raw = (qs.get("tickers") or qs.get("symbols") or [""])[0]
            tickers = _normalize_tickers(raw)
            if not tickers:
                return _send_json(self, 400, {"error": "tickers gerekli. Örn: /api/quotes?tickers=ALARK,FORTE"})
            try:
                payload = _fetch_tradingview_quotes(tickers)
                return _send_json(self, 200, payload)
            except Exception as e:
                return _send_json(self, 502, {"error": str(e)})

        if url.path == "/api/history":
            qs = parse_qs(url.query)
            raw = (qs.get("tickers") or qs.get("symbols") or [""])[0]
            tickers = _normalize_tickers(raw)
            if not tickers:
                return _send_json(self, 400, {"error": "tickers gerekli."})

            start_key = (qs.get("start") or [""])[0] or None
            end_key = (qs.get("end") or [""])[0] or None
            start_sec = _parse_date_key(start_key)
            end_sec = _parse_date_key(end_key)
            end_sec = end_sec + 86400 if end_sec is not None else None

            series: dict[str, dict] = {}
            errors: dict[str, str] = {}
            for t in tickers[:25]:
                try:
                    series[t] = _fetch_yahoo_history(t, start_sec, end_sec)
                except Exception as e:
                    errors[t] = str(e)

            return _send_json(
                self,
                200,
                {
                    "source": "yahoo:chart",
                    "asOf": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "start": start_key,
                    "end": end_key,
                    "series": series,
                    "errors": errors,
                    "requested": len(tickers),
                    "returned": len(series),
                },
            )

        return super().do_GET()


def main():
    port = 8000
    if len(sys.argv) >= 2:
        try:
            port = int(sys.argv[1])
        except Exception:
            port = 8000

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"SWPort Python server running: http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()

# Swing Trade Portföy

Statik (HTML/CSS/JS) portföy paneli. Veri `data/portfolio.json` içinden okunur.

## Çalıştırma

Tarayıcılar `file://` altında JSON `fetch` isteğini engelleyebilir.

- Kolay yol: `index.html` aç, sayfadaki dosya seçiciden `data/portfolio.json` dosyasını seç.
- Canlı borsa verisi + anlık istatistikler için:

```bash
py -3 server.py 8000
```

Sonra `http://127.0.0.1:8000` adresini aç.

- Alternatif (Node.js yüklüyse):

```bash
node server.mjs
```

Sonra `http://127.0.0.1:4173` adresini aç.

- Alternatif (sadece statik servis; canlı veri yok): `py -m http.server 8000` veya `npx serve`

```bash
npx serve
```

Sonra terminalde verilen URL’den `index.html` sayfasına gir.

Not: Canlı fiyatlar, TradingView scanner endpoint’i üzerinden çekilir ve CORS nedeniyle `server.mjs` proxy’si gerekir.

## Veri güncelleme

Pozisyonları `data/portfolio.json` dosyasında düzenleyebilirsin.

`outcome` alanı opsiyoneldir:
- `0`: stop (zarar durdur) → çıkış fiyatı `stopLoss`
- `1`: tp (kâr al) → çıkış fiyatı `takeProfit`

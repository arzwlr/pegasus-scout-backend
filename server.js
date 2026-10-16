// Pegasus Scout — Backend proxy
// Node.js 18+ · Deploy on Railway / Render / Fly.io (free tier)
//
// POST /prices  { make, model, year, mileage, fuelType }
// GET  /health

import express from 'express';
import cors    from 'cors';

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS: allow only the extension origin ────────────────
app.use(cors({
  origin: (origin, cb) => {
    // Chrome/Opera extensions send origin = "chrome-extension://<id>"
    // or null for some requests — allow both
    if (!origin || /^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// ── In-memory cache: 4h TTL ──────────────────────────────
const cache   = new Map();
const TTL_MS  = 4 * 60 * 60 * 1000;

function cacheKey(car) {
  const km = Math.round((car.mileage || 0) / 20000) * 20000;
  return `${car.make}|${car.model}|${car.year}|${km}`.toLowerCase();
}

// ── Browser-like headers ─────────────────────────────────
const COMMON_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ── Wallapop ─────────────────────────────────────────────
async function fetchWallapop(car) {
  const params = new URLSearchParams({
    latitude:     '40.4168',
    longitude:    '-3.7038',
    category_ids: '100',
    make:          car.make,
    model:         car.model,
    min_year:      String((car.year || 2020) - 1),
    max_year:      String((car.year || 2020) + 2),
    max_km:        String((car.mileage || 60000) + 30000),
    distance:      '500000',
    order_by:      'price_low_to_high',
    start:         '0',
    step:          '40',
  });

  const url = `https://api.wallapop.com/api/v3/cars/search?${params}`;
  const res  = await fetch(url, {
    headers: {
      ...COMMON_HEADERS,
      'Accept':  'application/json, text/plain, */*',
      'Origin':  'https://es.wallapop.com',
      'Referer': 'https://es.wallapop.com/',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Wallapop HTTP ${res.status}`);
  const data = await res.json();

  const items = data?.search_objects ?? data?.data?.search_objects ?? [];
  const prices = items
    .map(i => i?.content?.sale_price ?? i?.sale_price)
    .filter(p => typeof p === 'number' && p > 1000);

  return { prices, source: 'wallapop' };
}

// ── coches.net ───────────────────────────────────────────
function slugify(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function extractPrices(html) {
  const prices = [];

  // Strategy 1: JSON-LD ItemList
  const ldMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const obj = JSON.parse(m[1]);
      const items = obj?.itemListElement ?? (obj?.['@type'] === 'Car' ? [obj] : []);
      for (const it of items) {
        const p = it?.offers?.price ?? it?.price;
        if (typeof p === 'number' && p > 1000) prices.push(p);
        if (typeof p === 'string' && parseFloat(p) > 1000) prices.push(parseFloat(p));
      }
    } catch { /* skip */ }
  }

  // Strategy 2: __NEXT_DATA__ blob
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const findPrices = (obj, depth = 0) => {
        if (depth > 12 || !obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          if ((k === 'price' || k === 'precio') && typeof v === 'number' && v > 1000) prices.push(v);
          else findPrices(v, depth + 1);
        }
      };
      findPrices(JSON.parse(nextMatch[1]));
    } catch { /* skip */ }
  }

  // Strategy 3: data-price attribute
  for (const m of html.matchAll(/data-price="(\d+)"/g)) {
    const p = parseInt(m[1]);
    if (p > 1000) prices.push(p);
  }

  // Strategy 4: JSON fragments  "precio": 24500  or  "price": 24500
  for (const m of html.matchAll(/"(?:precio|price)"\s*:\s*(\d{4,6})/g)) {
    const p = parseInt(m[1]);
    if (p > 1000) prices.push(p);
  }

  return [...new Set(prices)];
}

async function fetchCochesNet(car) {
  const makeSlug  = slugify(car.make);
  const modelSlug = slugify(car.model);
  const year      = car.year  || 2021;
  const km        = car.mileage || 60000;

  const url = `https://www.coches.net/coches-segunda-mano/${makeSlug}-${modelSlug}/` +
    `?anofin=${year - 1}&anohasta=${year + 2}&kmdesde=0&kmhasta=${km + 30000}&preciodesde=5000`;

  const res = await fetch(url, {
    headers: { ...COMMON_HEADERS, 'Referer': 'https://www.coches.net/' },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) throw new Error(`coches.net HTTP ${res.status}`);
  const html = await res.text();
  const prices = extractPrices(html);

  return { prices, source: 'coches.net' };
}

// ── Outlier trimming ─────────────────────────────────────
function trimmedStats(prices) {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const cut    = Math.max(1, Math.floor(sorted.length * 0.10));
  const trimmed = sorted.length > 4 ? sorted.slice(cut, -cut) : sorted;
  const avg = Math.round(trimmed.reduce((s, p) => s + p, 0) / trimmed.length);
  return {
    min:        sorted[0],
    max:        sorted[sorted.length - 1],
    avg,
    trimmedAvg: avg,
    count:      trimmed.length,
    rawCount:   prices.length,
  };
}

function estimateDays(fuelType, count) {
  const isPhev = fuelType && /plug|phev|hybrid|enchufable/i.test(fuelType);
  if (isPhev) return count > 40 ? 35 : 25;
  return count > 100 ? 55 : count > 50 ? 42 : 35;
}

// ── POST /prices ─────────────────────────────────────────
app.post('/prices', async (req, res) => {
  const car = req.body;
  if (!car?.make || !car?.model) {
    return res.status(400).json({ error: 'make and model required' });
  }

  // Cache check
  const key = cacheKey(car);
  const hit  = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return res.json({ ...hit.data, cached: true });
  }

  // Fetch both sources in parallel
  const [wallapopResult, cochesResult] = await Promise.allSettled([
    fetchWallapop(car),
    fetchCochesNet(car),
  ]);

  const allPrices = [];
  const sources   = [];

  if (wallapopResult.status === 'fulfilled' && wallapopResult.value.prices.length) {
    allPrices.push(...wallapopResult.value.prices);
    sources.push('wallapop');
  }
  if (cochesResult.status === 'fulfilled' && cochesResult.value.prices.length) {
    allPrices.push(...cochesResult.value.prices);
    sources.push('coches.net');
  }

  if (!allPrices.length) {
    return res.status(404).json({
      error: 'No prices found',
      wallapopError: wallapopResult.reason?.message,
      cochesError:   cochesResult.reason?.message,
    });
  }

  const stats = trimmedStats(allPrices);
  const data  = {
    ...stats,
    avgDaysToSell: estimateDays(car.fuelType, stats.rawCount),
    source: sources.join(' · '),
    cached: false,
  };

  cache.set(key, { ts: Date.now(), data });
  res.json(data);
});

// ── GET /health ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Clear cache endpoint ─────────────────────────────────
app.post('/cache/clear', (_req, res) => {
  cache.clear();
  res.json({ cleared: true });
});

app.listen(PORT, () => console.log(`Pegasus Scout backend · port ${PORT}`));

// Pegasus Scout — Backend proxy v1.1
// Node.js 18+ · Deploy on Railway / Render / Fly.io (free tier)
//
// POST /prices  { make, model, year, mileage, fuelType }
// GET  /health
// GET  /debug?make=Mercedes-Benz&model=C300&year=2018&mileage=16500

import express from 'express';
import cors    from 'cors';

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS: allow extension origins + direct browser access ─
app.use(cors({
  origin: (origin, cb) => {
    if (!origin
      || /^chrome-extension:\/\//.test(origin)
      || /^moz-extension:\/\//.test(origin)
      || /^opera-extension:\/\//.test(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// ── In-memory cache: 4h TTL ──────────────────────────────
const cache  = new Map();
const TTL_MS = 4 * 60 * 60 * 1000;

function cacheKey(car) {
  const km = Math.round((car.mileage || 0) / 20000) * 20000;
  return `${car.make}|${car.model}|${car.year}|${km}`.toLowerCase();
}

// ── Browser-like headers ─────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Wallapop ─────────────────────────────────────────────
const WALLAPOP_MAKES = {
  'mercedes-benz':'Mercedes-Benz','mercedes':'Mercedes-Benz',
  'audi':'Audi','bmw':'BMW','volkswagen':'Volkswagen','vw':'Volkswagen',
  'toyota':'Toyota','volvo':'Volvo','lexus':'Lexus','peugeot':'Peugeot',
  'renault':'Renault','ford':'Ford','hyundai':'Hyundai','kia':'Kia',
  'porsche':'Porsche','seat':'SEAT','cupra':'Cupra','skoda':'Skoda',
  'opel':'Opel','nissan':'Nissan','honda':'Honda','mazda':'Mazda',
  'land rover':'Land Rover','mini':'MINI','fiat':'Fiat',
  'alfa romeo':'Alfa Romeo','citroen':'Citroën','jaguar':'Jaguar',
  'tesla':'Tesla','dacia':'Dacia','mitsubishi':'Mitsubishi','jeep':'Jeep',
};

function normMake(make) {
  return WALLAPOP_MAKES[(make || '').toLowerCase()] || make;
}

async function fetchWallapop(car) {
  const params = new URLSearchParams({
    latitude:     '40.4168',
    longitude:    '-3.7038',
    category_ids: '100',
    make:          normMake(car.make),
    model:         car.model || '',
    min_year:      String((car.year || 2020) - 3),
    max_year:      String((car.year || 2020) + 3),
    max_km:        '250000',
    distance:      '500000',
    order_by:      'price_low_to_high',
    start:         '0',
    step:          '40',
  });

  const url = `https://api.wallapop.com/api/v3/cars/search?${params}`;
  console.log('[wallapop] GET', url);

  const res = await fetch(url, {
    headers: {
      'User-Agent':      UA,
      'Accept':          'application/json, text/plain, */*',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Origin':          'https://es.wallapop.com',
      'Referer':         'https://es.wallapop.com/coches-segunda-mano',
      'X-DeviceOS':      '0',
    },
    signal: AbortSignal.timeout(12000),
  });

  console.log('[wallapop] status', res.status);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.log('[wallapop] error body:', body.slice(0, 200));
    throw new Error(`Wallapop HTTP ${res.status}`);
  }

  const data  = await res.json();

  // API v3 structure: data.section.payload.items OR search_objects
  const items =
    data?.data?.section?.payload?.items ??
    data?.search_objects ??
    data?.data?.search_objects ??
    [];

  console.log('[wallapop] items found:', items.length);

  const prices = items
    .map(i => {
      const p = i?.price?.amount ?? i?.content?.sale_price ?? i?.sale_price;
      return typeof p === 'number' ? p : (p ? parseFloat(p) : null);
    })
    .filter(p => p && p > 1000 && p < 350000);

  console.log('[wallapop] valid prices:', prices.length, prices.slice(0, 5));
  return { prices, source: 'wallapop' };
}

// ── coches.net ───────────────────────────────────────────
function slugify(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');
}

function extractPrices(html) {
  const prices = [];

  // Strategy 1: JSON-LD
  for (const m of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const obj = JSON.parse(m[1]);
      const items = obj?.itemListElement ?? (Array.isArray(obj) ? obj : [obj]);
      for (const it of items) {
        const p = it?.offers?.price ?? it?.item?.offers?.price ?? it?.price;
        const n = parseFloat(p);
        if (n > 1000 && n < 350000) prices.push(n);
      }
    } catch {}
  }

  // Strategy 2: __NEXT_DATA__
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nd) {
    try {
      const walk = (obj, d = 0) => {
        if (d > 15 || !obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          if ((k === 'price' || k === 'precio' || k === 'amount') && typeof v === 'number' && v > 1000 && v < 350000) {
            prices.push(v);
          } else {
            walk(v, d + 1);
          }
        }
      };
      walk(JSON.parse(nd[1]));
    } catch {}
  }

  // Strategy 3: data-price
  for (const m of html.matchAll(/data-price="(\d+)"/g)) {
    const p = parseInt(m[1]);
    if (p > 1000 && p < 350000) prices.push(p);
  }

  // Strategy 4: JSON fragments
  for (const m of html.matchAll(/"(?:precio|price|amount|pvp)"\s*:\s*(\d{4,6})/g)) {
    const p = parseInt(m[1]);
    if (p > 1000 && p < 350000) prices.push(p);
  }

  // Strategy 5: text patterns like "24.500 €" or "24500€"
  for (const m of html.matchAll(/(\d{1,3}(?:\.\d{3})+)\s*€/g)) {
    const p = parseInt(m[1].replace(/\./g, ''));
    if (p > 1000 && p < 350000) prices.push(p);
  }

  return [...new Set(prices)];
}

async function fetchCochesNet(car) {
  const makeSlug  = slugify(car.make);
  const modelSlug = slugify(car.model);
  const year      = car.year   || 2021;
  const km        = car.mileage || 60000;

  const url = `https://www.coches.net/coches-segunda-mano/${makeSlug}-${modelSlug}/` +
    `?anofin=${year - 3}&anohasta=${year + 3}&kmdesde=0&kmhasta=250000&preciodesde=3000`;

  console.log('[coches.net] GET', url);

  const res = await fetch(url, {
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Referer':         'https://www.coches.net/',
      'Cache-Control':   'no-cache',
    },
    signal: AbortSignal.timeout(15000),
  });

  console.log('[coches.net] status', res.status);
  if (!res.ok) throw new Error(`coches.net HTTP ${res.status}`);

  const html   = await res.text();
  const prices = extractPrices(html);
  console.log('[coches.net] prices found:', prices.length, prices.slice(0, 5));

  return { prices, source: 'coches.net' };
}

// ── autocasion.com (extra source) ────────────────────────
async function fetchAutocasion(car) {
  const makeSlug  = slugify(car.make);
  const year      = car.year || 2021;
  const km        = car.mileage || 60000;

  // Autocasion uses a JSON API
  const url = `https://www.autocasion.com/api/search/coches-segunda-mano?` +
    new URLSearchParams({
      marca: makeSlug,
      modelo: slugify(car.model),
      anyoDesde: String(year - 1),
      anyoHasta: String(year + 2),
      kmHasta: String(km + 30000),
    });

  console.log('[autocasion] GET', url);

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://www.autocasion.com/' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`autocasion HTTP ${res.status}`);
  const data   = await res.json();
  const items  = data?.data ?? data?.items ?? data?.results ?? [];
  const prices = items
    .map(i => i?.precio ?? i?.price ?? i?.pvp)
    .filter(p => typeof p === 'number' && p > 1000 && p < 350000);

  console.log('[autocasion] prices:', prices.length);
  return { prices, source: 'autocasion' };
}

// ── Outlier trimming ─────────────────────────────────────
function trimmedStats(prices) {
  if (!prices.length) return null;
  const sorted  = [...prices].sort((a, b) => a - b);
  const cut     = sorted.length > 6 ? Math.floor(sorted.length * 0.10) : 0;
  const trimmed = cut ? sorted.slice(cut, -cut) : sorted;
  const avg     = Math.round(trimmed.reduce((s, p) => s + p, 0) / trimmed.length);
  return { min: sorted[0], max: sorted[sorted.length - 1], avg, trimmedAvg: avg, count: trimmed.length, rawCount: prices.length };
}

function estimateDays(fuelType, count) {
  const isPhev = /plug|phev|hybrid|enchufable/i.test(fuelType || '');
  if (isPhev) return count > 40 ? 35 : 25;
  return count > 100 ? 55 : count > 50 ? 42 : 35;
}

// ── POST /prices ─────────────────────────────────────────
app.post('/prices', async (req, res) => {
  const car = req.body;
  console.log('[/prices] request:', car);
  if (!car?.make || !car?.model) return res.status(400).json({ error: 'make and model required' });

  const key = cacheKey(car);
  const hit  = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    console.log('[/prices] cache hit');
    return res.json({ ...hit.data, cached: true });
  }

  const [wpRes, cnRes, acRes] = await Promise.allSettled([
    fetchWallapop(car),
    fetchCochesNet(car),
    fetchAutocasion(car),
  ]);

  const allPrices = [];
  const sources   = [];

  for (const [r, name] of [[wpRes,'wallapop'],[cnRes,'coches.net'],[acRes,'autocasion']]) {
    if (r.status === 'fulfilled' && r.value.prices.length) {
      allPrices.push(...r.value.prices);
      sources.push(name);
    } else if (r.status === 'rejected') {
      console.log(`[/prices] ${name} failed:`, r.reason?.message);
    }
  }

  console.log('[/prices] total prices collected:', allPrices.length, 'from:', sources);

  if (!allPrices.length) {
    return res.status(404).json({
      error: 'No prices found',
      detail: {
        wallapop:   wpRes.reason?.message ?? 'ok but 0 prices',
        coches:     cnRes.reason?.message ?? 'ok but 0 prices',
        autocasion: acRes.reason?.message ?? 'ok but 0 prices',
      },
    });
  }

  const stats = trimmedStats(allPrices);
  const data  = { ...stats, avgDaysToSell: estimateDays(car.fuelType, stats.rawCount), source: sources.join(' · '), cached: false };

  cache.set(key, { ts: Date.now(), data });
  res.json(data);
});

// ── GET /debug ────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const car = { make: req.query.make || 'Mercedes-Benz', model: req.query.model || 'C 300', year: parseInt(req.query.year) || 2018, mileage: parseInt(req.query.mileage) || 16500 };
  console.log('[/debug] testing with:', car);
  const [wpRes, cnRes] = await Promise.allSettled([fetchWallapop(car), fetchCochesNet(car)]);
  res.json({
    car,
    wallapop:  wpRes.status === 'fulfilled' ? { count: wpRes.value.prices.length, sample: wpRes.value.prices.slice(0,5) } : { error: wpRes.reason?.message },
    cochesNet: cnRes.status === 'fulfilled' ? { count: cnRes.value.prices.length, sample: cnRes.value.prices.slice(0,5) } : { error: cnRes.reason?.message },
  });
});

// ── GET /health ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now(), version: '1.1' }));

// ── POST /cache/clear ─────────────────────────────────────
app.post('/cache/clear', (_req, res) => { cache.clear(); res.json({ cleared: true }); });

app.listen(PORT, () => console.log(`Pegasus Scout backend v1.1 · port ${PORT}`));

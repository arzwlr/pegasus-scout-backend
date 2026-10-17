// Pegasus Scout — Backend proxy v1.9
// Node.js 18+ · Deploy on Render / Railway / Fly.io
//
// POST /prices  { make, model, year, mileage, fuelType }
// GET  /health
// GET  /debug?make=Mercedes-Benz&model=C%20300&year=2018&mileage=16500

import express from 'express';
import cors    from 'cors';

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ────────────────────────────────────────────────────
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

// ── Cache 4h ────────────────────────────────────────────────
const cache  = new Map();
const TTL_MS = 4 * 60 * 60 * 1000;
function cacheKey(car) {
  const km = Math.round((car.mileage || 0) / 20000) * 20000;
  return `${car.make}|${car.model}|${car.year}|${km}`.toLowerCase();
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── ScraperAPI proxy ─────────────────────────────────────────
// Routes blocked portals (coches.net, wallapop, milanuncios) through
// residential IPs with JS rendering. Falls back to direct fetch if no key.
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || 'cc1489f05711db051fe6ae3f979ec8d9';

async function scrapedFetch(url, opts = {}) {
  if (!SCRAPER_KEY) return fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const proxied = `https://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=true&country_code=es`;
  return fetch(proxied, { signal: AbortSignal.timeout(30000) });
}

// ── Slug helpers ─────────────────────────────────────────────
function slugify(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Model slug mapping for coches.net ────────────────────────
// coches.net uses Spanish class names, not German trim designations
const COCHES_MODEL_MAP = {
  'mercedes-benz': {
    default: (m) => {
      const u = m.toUpperCase();
      if (/^A\s?\d/.test(u)) return 'clase-a';
      if (/^B\s?\d/.test(u)) return 'clase-b';
      if (/^C\s?\d/.test(u) || u === 'C') return 'clase-c';
      if (/^E\s?\d/.test(u) || u === 'E') return 'clase-e';
      if (/^S\s?\d/.test(u) || u === 'S') return 'clase-s';
      if (/^G\s?\d/.test(u) || u === 'G') return 'clase-g';
      if (/^GLA/.test(u)) return 'gla';
      if (/^GLB/.test(u)) return 'glb';
      if (/^GLC/.test(u)) return 'glc';
      if (/^GLE/.test(u)) return 'gle';
      if (/^GLS/.test(u)) return 'gls';
      if (/^CLA/.test(u)) return 'cla';
      if (/^CLS/.test(u)) return 'cls';
      if (/^EQA/.test(u)) return 'eqa';
      if (/^EQB/.test(u)) return 'eqb';
      if (/^EQC/.test(u)) return 'eqc';
      if (/^EQE/.test(u)) return 'eqe';
      if (/^EQS/.test(u)) return 'eqs';
      if (/^SL/.test(u)) return 'sl';
      if (/^AMG/.test(u)) return 'amg-gt';
      return slugify(m);
    },
  },
  'bmw': {
    default: (m) => {
      const u = m.toUpperCase().trim();
      if (/^1\s/.test(u) || u === '1' || /SERIE\s*1/.test(u)) return 'serie-1';
      if (/^2\s/.test(u) || u === '2' || /SERIE\s*2/.test(u)) return 'serie-2';
      if (/^3\s/.test(u) || u === '3' || /SERIE\s*3/.test(u)) return 'serie-3';
      if (/^4\s/.test(u) || u === '4' || /SERIE\s*4/.test(u)) return 'serie-4';
      if (/^5\s/.test(u) || u === '5' || /SERIE\s*5/.test(u)) return 'serie-5';
      if (/^6\s/.test(u) || u === '6' || /SERIE\s*6/.test(u)) return 'serie-6';
      if (/^7\s/.test(u) || u === '7' || /SERIE\s*7/.test(u)) return 'serie-7';
      if (/^X1/.test(u)) return 'x1';
      if (/^X2/.test(u)) return 'x2';
      if (/^X3/.test(u)) return 'x3';
      if (/^X4/.test(u)) return 'x4';
      if (/^X5/.test(u)) return 'x5';
      if (/^X6/.test(u)) return 'x6';
      if (/^X7/.test(u)) return 'x7';
      if (/^Z4/.test(u)) return 'z4';
      if (/^I3/.test(u)) return 'i3';
      if (/^I4/.test(u)) return 'i4';
      if (/^I5/.test(u)) return 'i5';
      if (/^I7/.test(u)) return 'i7';
      if (/^M3/.test(u)) return 'm3';
      if (/^M4/.test(u)) return 'm4';
      if (/^M5/.test(u)) return 'm5';
      return slugify(m);
    },
  },
  'audi': {
    default: (m) => {
      const u = m.toUpperCase().trim();
      if (/^A1/.test(u)) return 'a1';
      if (/^A3/.test(u)) return 'a3';
      if (/^A4/.test(u)) return 'a4';
      if (/^A5/.test(u)) return 'a5';
      if (/^A6/.test(u)) return 'a6';
      if (/^A7/.test(u)) return 'a7';
      if (/^A8/.test(u)) return 'a8';
      if (/^Q2/.test(u)) return 'q2';
      if (/^Q3/.test(u)) return 'q3';
      if (/^Q4/.test(u)) return 'q4';
      if (/^Q5/.test(u)) return 'q5';
      if (/^Q7/.test(u)) return 'q7';
      if (/^Q8/.test(u)) return 'q8';
      if (/^TT/.test(u)) return 'tt';
      if (/^E-TRON/.test(u) || /^ETRON/.test(u)) return 'e-tron';
      if (/^RS/.test(u)) return slugify(m.split(' ')[0]);
      if (/^S[0-9]/.test(u)) return slugify(m.split(' ')[0]);
      return slugify(m);
    },
  },
};

function getCochesNetModelSlug(make, model) {
  const makeKey = (make || '').toLowerCase().trim();
  const entry   = COCHES_MODEL_MAP[makeKey];
  if (entry) return entry.default(model);
  return slugify(model);
}

// ── Wallapop make normalizer ────────────────────────────────
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

// Simplify model for Wallapop (strip trim suffix: "C 300" → "C")
function normModelWallapop(make, model) {
  const m = (model || '').trim();
  // Mercedes: "C 300 d" → "C", "GLC 300" → "GLC"
  if (/mercedes/i.test(make)) {
    const first = m.split(/\s+/)[0];
    return /^[A-Z]+$/.test(first) ? first : m;
  }
  // BMW: "320d" → "3 Series", etc. — just pass first token
  if (/bmw/i.test(make)) {
    const match = m.match(/^([1-9]|X[1-9]|Z[1-9]|i[0-9]|M[0-9]|iX)/i);
    return match ? match[1] : m.split(/\s+/)[0];
  }
  // Default: strip trailing engine code ("A4 2.0 TFSI" → "A4")
  return m.split(/\s+/).slice(0, 2).join(' ');
}

// ── Wallapop ─────────────────────────────────────────────────
async function fetchWallapop(car) {
  const make  = normMake(car.make);
  const model = normModelWallapop(car.make, car.model);
  const year  = car.year || 2020;

  const params = new URLSearchParams({
    latitude:     '40.4168',
    longitude:    '-3.7038',
    category_ids: '100',
    make,
    model,
    min_year:     String(year - 3),
    max_year:     String(year + 3),
    max_km:       '250000',
    distance:     '500000',
    order_by:     'price_low_to_high',
    start:        '0',
    step:         '40',
  });

  const url = `https://api.wallapop.com/api/v3/cars/search?${params}`;
  console.log('[wallapop] GET', url);

  const res = await scrapedFetch(url);

  console.log('[wallapop] status', res.status);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.log('[wallapop] error body:', body.slice(0, 300));
    throw new Error(`Wallapop HTTP ${res.status}`);
  }

  const data = await res.json();
  // Log structure for debugging
  const keys = Object.keys(data || {});
  console.log('[wallapop] top-level keys:', keys);

  const items =
    data?.data?.section?.payload?.items ??
    data?.search_objects ??
    data?.data?.search_objects ??
    [];

  console.log('[wallapop] items found:', items.length);

  // If 0 with model, retry without model
  if (items.length === 0 && model) {
    console.log('[wallapop] retrying without model param…');
    return fetchWallapopNoModel(car, make, year);
  }

  const prices = items
    .map(i => i?.price?.amount ?? i?.content?.sale_price ?? i?.sale_price)
    .filter(p => p != null)
    .map(p => typeof p === 'number' ? p : parseFloat(p))
    .filter(p => !isNaN(p) && p > 1000 && p < 350000);

  console.log('[wallapop] valid prices:', prices.length, prices.slice(0, 5));
  return { prices, source: 'wallapop' };
}

async function fetchWallapopNoModel(car, make, year) {
  const params = new URLSearchParams({
    latitude:     '40.4168',
    longitude:    '-3.7038',
    category_ids: '100',
    make,
    min_year:     String(year - 2),
    max_year:     String(year + 2),
    max_km:       '200000',
    distance:     '500000',
    order_by:     'price_low_to_high',
    start:        '0',
    step:         '40',
  });

  const url = `https://api.wallapop.com/api/v3/cars/search?${params}`;
  console.log('[wallapop-nomodel] GET', url);

  const res = await fetch(url, {
    headers: {
      'User-Agent':      UA,
      'Accept':          'application/json',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Origin':          'https://es.wallapop.com',
      'Referer':         'https://es.wallapop.com/coches-segunda-mano',
      'X-DeviceOS':      '0',
    },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) throw new Error(`Wallapop(nomodel) HTTP ${res.status}`);
  const data  = await res.json();
  const items = data?.data?.section?.payload?.items ?? data?.search_objects ?? [];
  console.log('[wallapop-nomodel] items:', items.length);

  const prices = items
    .map(i => i?.price?.amount ?? i?.content?.sale_price ?? i?.sale_price)
    .filter(p => p != null)
    .map(p => typeof p === 'number' ? p : parseFloat(p))
    .filter(p => !isNaN(p) && p > 1000 && p < 350000);

  console.log('[wallapop-nomodel] prices:', prices.length);
  return { prices, source: 'wallapop' };
}

// ── coches.net ───────────────────────────────────────────────
function extractPrices(html) {
  const prices = [];

  // Strategy 1: JSON-LD
  for (const m of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const obj   = JSON.parse(m[1]);
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

  // Strategy 5: "24.500 €" text pattern
  for (const m of html.matchAll(/(\d{1,3}(?:\.\d{3})+)\s*€/g)) {
    const p = parseInt(m[1].replace(/\./g, ''));
    if (p > 1000 && p < 350000) prices.push(p);
  }

  return [...new Set(prices)];
}

async function fetchCochesNet(car) {
  const makeSlug  = slugify(car.make);
  const modelSlug = getCochesNetModelSlug(car.make, car.model);
  const year      = car.year || 2021;

  const kmCap = Math.min(Math.max(Math.round((car.mileage || 60000) * 3 / 10000) * 10000, 50000), 250000);
  const url = `https://www.coches.net/coches-segunda-mano/${makeSlug}-${modelSlug}/` +
    `?anofin=${year - 2}&anohasta=${year + 2}&kmdesde=0&kmhasta=${kmCap}&preciodesde=3000`;

  console.log('[coches.net] GET', url);

  const res = await scrapedFetch(url);

  console.log('[coches.net] status', res.status, 'url-slug:', `${makeSlug}-${modelSlug}`);
  if (!res.ok) throw new Error(`coches.net HTTP ${res.status} (slug: ${makeSlug}-${modelSlug})`);

  const html   = await res.text();
  console.log('[coches.net] html length:', html.length);
  const prices = extractPrices(html);
  console.log('[coches.net] prices:', prices.length, prices.slice(0, 5));

  return { prices, source: 'coches.net' };
}

// ── Model slug normalizer for Autoscout24 ────────────────────
// AS24 uses /lst/<make>/<model-slug> — strip engine/trim codes,
// keep only the base model identifier Autoscout24 actually understands.
function getAS24ModelSlug(make, model) {
  const m  = (model || '').trim();
  const mk = (make  || '').toLowerCase();

  if (/mercedes/i.test(mk)) {
    const u = m.toUpperCase();
    if (/^A[\s-]?\d/.test(u) || /^A$/.test(u.split(/\s/)[0])) return 'a-klasse';
    if (/^B[\s-]?\d/.test(u))                                   return 'b-klasse';
    if (/^C[\s-]?\d/.test(u) || /^C$/.test(u.split(/\s/)[0]))  return 'c-klasse';
    if (/^E[\s-]?\d/.test(u) || /^E$/.test(u.split(/\s/)[0]))  return 'e-klasse';
    if (/^S[\s-]?\d/.test(u) || /^S$/.test(u.split(/\s/)[0]))  return 's-klasse';
    if (/^G[\s-]?\d/.test(u) || /^G$/.test(u.split(/\s/)[0]))  return 'g-klasse';
    if (/^GLA/.test(u)) return 'gla'; if (/^GLB/.test(u)) return 'glb';
    if (/^GLC/.test(u)) return 'glc'; if (/^GLE/.test(u)) return 'gle';
    if (/^GLS/.test(u)) return 'gls'; if (/^CLA/.test(u)) return 'cla';
    if (/^CLS/.test(u)) return 'cls'; if (/^EQA/.test(u)) return 'eqa';
    if (/^EQB/.test(u)) return 'eqb'; if (/^EQC/.test(u)) return 'eqc';
    if (/^EQE/.test(u)) return 'eqe'; if (/^EQS/.test(u)) return 'eqs';
    if (/^SL/.test(u))  return 'sl';  if (/^AMG/.test(u)) return 'amg-gt';
    return slugify(m.split(/\s+/)[0]);
  }

  if (/^audi$/i.test(mk)) {
    // Keep base model + Sportback/Avant/Allroad if present; drop engine codes
    const tokens = m.split(/\s+/);
    const keep = tokens.filter((t, i) => {
      if (i === 0) return true;
      return /^(sportback|avant|allroad|cabrio|coupe|limousine|plus|black\s*edition)$/i.test(t);
    });
    return slugify(keep.join(' '));
  }

  if (/^bmw$/i.test(mk)) {
    const u = m.toUpperCase().trim();
    // "320d xDrive" or "3" or "3 Series" → "3er"; "X3", "M4", "iX" → as-is first token
    const ser = u.match(/^([1-9])/);
    if (ser && !/^(X|M|Z|I)/i.test(u)) return ser[1] + 'er';
    return slugify(m.split(/\s+/)[0]);
  }

  if (/^volkswagen$|^vw$/i.test(mk)) {
    // "Golf 8" → "golf", "Tiguan Allspace" → "tiguan-allspace"
    const tokens = m.split(/\s+/);
    const keep = tokens.filter((t, i) => {
      if (i === 0) return true;
      return /^(allspace|alltrack|sportsvan|r-line|plus)$/i.test(t);
    });
    return slugify(keep.join(' '));
  }

  // Generic: keep first 2 words, strip trailing engine codes (digits, d, e, TDI, etc.)
  const parts = m.split(/\s+/)
    .filter(t => !/^\d+(\.\d+)?[a-z]?$/i.test(t))       // e.g. "2.0", "45e", "300d"
    .filter(t => !/^(tdi|tfsi|tsi|gtd|gti|gts|gta|phev|hybrid|mhev|amg|sport|line|quattro|xdrive|4matic|s\s*line|edition|business|executive|advance|style|select|premium|plus|pack|pro)$/i.test(t));
  return slugify(parts.slice(0, 2).join(' ')) || slugify(m.split(/\s+/)[0]);
}

// ── Fuel param for Autoscout24 ────────────────────────────────
function getAS24FuelParam(fuelType) {
  const f = (fuelType || '').toLowerCase();
  if (/elektr|electric|bev/.test(f))            return '&fuel=E';
  if (/plug|phev|enchuf/.test(f))               return '&fuel=M'; // plug-in hybrid
  if (/hybrid/.test(f))                         return '&fuel=H'; // mild/full hybrid
  if (/diesel/.test(f))                         return '&fuel=D';
  if (/benzin|gasolina|gasoline|petrol/.test(f)) return '&fuel=B';
  return '';
}

// ── Autoscout24 España ───────────────────────────────────────
async function fetchAutoscout24(car) {
  const year      = car.year || 2021;
  const modelSlug = getAS24ModelSlug(car.make, car.model);
  const fuelParam = getAS24FuelParam(car.fuelType);

  // km cap: compare like-for-like — scale with car's mileage, min 50k
  const mileage = car.mileage || 60000;
  // km band: ±60 000 km around the car's mileage, capped at [0, 250 000]
  const kmFrom = Math.max(0, Math.round((mileage - 60000) / 10000) * 10000);
  const kmTo   = Math.min(250000, Math.round((mileage + 60000) / 10000) * 10000);

  const url = `https://www.autoscout24.es/lst/${slugify(car.make)}/${modelSlug}` +
    `?atype=C&cy=E&damaged=N&desc=0&fyear=${year-2}&lyear=${year+2}` +
    `&kmfrom=${kmFrom}&kmto=${kmTo}&powertype=kw&search_id=0&sort=price&source=listpage_pagination&ustate=N%2CU${fuelParam}`;

  console.log('[autoscout24] model-slug:', modelSlug, 'fuel:', fuelParam || 'any');

  console.log('[autoscout24] GET', url);

  const res = await fetch(url, {
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,*/*',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Referer':         'https://www.autoscout24.es/',
    },
    signal: AbortSignal.timeout(15000),
  });

  console.log('[autoscout24] status', res.status);
  if (!res.ok) throw new Error(`autoscout24 HTTP ${res.status}`);

  const html = await res.text();
  const { prices, items } = extractListingsAutoscout(html);
  console.log('[autoscout24] prices:', prices.length, 'items:', items.length, prices.slice(0, 5));
  return { prices, items, source: 'autoscout24' };
}

// ── Deep helpers ─────────────────────────────────────────────
// Search an object tree for the first numeric value at a given key
function deepFind(obj, key, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFind(v, key, depth + 1);
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

// Extract price from an object or any of its descendants
function deepPrice(obj, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  // Direct numeric checks
  for (const k of ['price','priceRaw','amount','value']) {
    if (typeof obj[k] === 'number' && obj[k] > 1000 && obj[k] < 350000) return obj[k];
  }
  // price.value / price.raw
  if (obj.price && typeof obj.price === 'object') {
    const pv = obj.price.value ?? obj.price.raw ?? obj.price.amount;
    if (typeof pv === 'number' && pv > 1000 && pv < 350000) return pv;
  }
  // Recurse
  for (const v of Object.values(obj)) {
    const r = deepPrice(v, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

// Extract first image URL from an object or its descendants
function deepImage(obj, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  // Common image array keys
  for (const k of ['images','photos','imageUrls','pictures']) {
    const arr = obj[k];
    if (Array.isArray(arr) && arr.length) {
      const first = arr[0];
      if (typeof first === 'string' && first.startsWith('http')) return first;
      const u = first?.url || first?.uri || first?.src || first?.bigUrl
             || first?.large || first?.medium || first?.thumbnail
             || first?.sizes?.big || first?.sizes?.large;
      if (typeof u === 'string' && u.startsWith('http')) return u;
    }
  }
  // Recurse into sub-objects (but skip arrays at top level to avoid noise)
  for (const [k, v] of Object.entries(obj)) {
    if (['images','photos'].includes(k) && Array.isArray(v)) continue; // already handled
    const r = deepImage(v, depth + 1);
    if (r) return r;
  }
  return null;
}

// Extract both prices AND individual listing items from Autoscout24 HTML
function extractListingsAutoscout(html) {
  const prices = [];
  const items  = [];

  // ── __NEXT_DATA__ ────────────────────────────────────────────
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nd) {
    try {
      const root = JSON.parse(nd[1]);

      // ── Strategy: walk with parent context
      // When we find a price, check BOTH current obj AND parent for id/images.
      // This handles the common case where price is in a sub-object (tracking.price)
      // while id and images live on the parent listing object.
      function walk(obj, depth, parent) {
        if (depth > 22 || !obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach(v => walk(v, depth + 1, null));
          return;
        }

        const rawPrice =
          (typeof obj.price === 'number' && obj.price > 1000 && obj.price < 350000 ? obj.price : null) ||
          (typeof obj.price?.value === 'number' && obj.price.value > 1000 && obj.price.value < 350000 ? obj.price.value : null) ||
          (typeof obj.price?.raw   === 'number' && obj.price.raw   > 1000 && obj.price.raw   < 350000 ? obj.price.raw   : null) ||
          (typeof obj.priceRaw     === 'number' && obj.priceRaw    > 1000 && obj.priceRaw    < 350000 ? obj.priceRaw    : null);

        if (rawPrice) {
          prices.push(Math.round(rawPrice));

          // Candidate objects: current + parent + grandparent
          const candidates = [obj, parent].filter(Boolean);
          let id = null, imgSrc = null, km = null, yr = null;

          for (const c of candidates) {
            if (!id)     id     = c.id || c.articleId || c.guid || c.listingId || c.vehicleId || c.offerId || null;
            if (!imgSrc) imgSrc = deepImage(c);
            if (!km)     km     = c.mileage?.value ?? c.mileage ?? c.km ?? deepFind(c, 'mileage')?.value ?? null;
            if (!yr)     yr     = c.firstRegistration?.year ?? c.firstRegistrationYear
                                ?? c.year ?? c.vehicleYear ?? deepFind(c, 'firstRegistration')?.year ?? null;
          }

          // Also check if current obj itself has an id field but we missed it
          if (!id) id = deepFind(obj, 'articleId') || deepFind(obj, 'listingId');

          if (id || imgSrc) {
            // Deduplicate by id
            const urlStr = id ? `https://www.autoscout24.es/anuncios/${id}` : null;
            if (!items.some(i => i.url === urlStr && urlStr)) {
              items.push({
                price: Math.round(rawPrice),
                url:   urlStr,
                image: imgSrc || null,
                km:    typeof km === 'number' ? km : parseInt(km) || null,
                year:  typeof yr === 'number' ? yr : parseInt(yr) || null,
              });
            }
          }
        }

        Object.values(obj).forEach(v => walk(v, depth + 1, obj));
      }

      walk(root, 0, null);

      // ── If still no items, try scanning for listing-shaped objects by id
      if (!items.length) {
        function findById(obj, depth) {
          if (depth > 15 || !obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) { obj.forEach(v => findById(v, depth + 1)); return; }
          // A listing object typically has a string id of 6+ chars AND contains a price somewhere
          const id = typeof obj.id === 'string' && obj.id.length >= 6 ? obj.id : null;
          if (id) {
            const p = deepPrice(obj);
            if (p) {
              prices.push(Math.round(p));
              const img = deepImage(obj);
              const km  = deepFind(obj, 'mileage');
              const yr  = deepFind(obj, 'year') || deepFind(obj, 'firstRegistration')?.year;
              const urlStr = `https://www.autoscout24.es/anuncios/${id}`;
              if (!items.some(i => i.url === urlStr)) {
                items.push({ price: Math.round(p), url: urlStr, image: img || null,
                  km: typeof km === 'object' ? (km?.value || null) : (parseInt(km) || null),
                  year: parseInt(yr) || null });
              }
              return; // Don't recurse into listing sub-objects
            }
          }
          Object.values(obj).forEach(v => findById(v, depth + 1));
        }
        findById(root, 0);
      }

    } catch(e) { console.log('[autoscout24] parse error:', e.message); }
  }

  // ── JSON fragment fallback for prices ────────────────────────
  for (const m of html.matchAll(/"(?:price|priceRaw|amount)"\s*:\s*(\d{4,6})/g)) {
    const p = parseInt(m[1]);
    if (p > 1000 && p < 350000) prices.push(p);
  }
  for (const m of html.matchAll(/(\d{1,3}(?:[.,]\d{3})+)\s*[€$]/g)) {
    const p = parseInt(m[1].replace(/[.,]/g, ''));
    if (p > 1000 && p < 350000) prices.push(p);
  }

  // ── href + price stub fallback (last resort) ─────────────────
  if (!items.length) {
    const hrefs = [...new Set(
      [...html.matchAll(/href="(\/anuncios\/[^"?#]{6,}?)"/g)].map(m => 'https://www.autoscout24.es' + m[1])
    )];
    // prices already collected above; sort and pair
    const stubPrices = [...new Set(prices)].sort((a,b) => a-b);
    for (let i = 0; i < Math.min(hrefs.length, 6, stubPrices.length); i++) {
      items.push({ price: stubPrices[i], url: hrefs[i], image: null, km: null, year: null });
    }
  }

  console.log('[autoscout24-extract] prices:', prices.length, 'items:', items.length,
    items.length ? ' sample0:' + JSON.stringify(items[0]) : '');

  return {
    prices: [...new Set(prices)],
    items:  items.filter(i => i.price).slice(0, 6),
  };
}

// ── Milanuncios coches ───────────────────────────────────────
async function fetchMilanuncios(car) {
  const makeSlug  = slugify(car.make);
  const modelSlug = slugify(car.model).split('-').slice(0,2).join('-'); // "c-300" → "c"
  const year      = car.year || 2021;

  const url = `https://www.milanuncios.com/coches-de-segunda-mano/?` +
    new URLSearchParams({
      marca: makeSlug,
      modelo: modelSlug,
      anumin: String(year - 3),
      anumax: String(year + 3),
      kmsmax: '250000',
    });

  console.log('[milanuncios] GET', url);
  const res = await scrapedFetch(url);

  console.log('[milanuncios] status', res.status);
  if (!res.ok) throw new Error(`milanuncios HTTP ${res.status}`);

  const html   = await res.text();
  const prices = [];

  // Milanuncios stores price in data attributes and JSON
  for (const m of html.matchAll(/data-price="(\d+)"/g)) {
    const p = parseInt(m[1]);
    if (p > 1000 && p < 350000) prices.push(p);
  }
  for (const m of html.matchAll(/"price"\s*:\s*(\d{4,6})/g)) {
    const p = parseInt(m[1]);
    if (p > 1000 && p < 350000) prices.push(p);
  }
  // "24.500 €"
  for (const m of html.matchAll(/(\d{1,3}(?:\.\d{3})+)\s*€/g)) {
    const p = parseInt(m[1].replace(/\./g, ''));
    if (p > 1000 && p < 350000) prices.push(p);
  }

  const unique = [...new Set(prices)];
  console.log('[milanuncios] prices:', unique.length, unique.slice(0, 5));
  return { prices: unique, source: 'milanuncios' };
}

// ── Stats ────────────────────────────────────────────────────
function trimmedStats(prices) {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);

  // Step 1: median-based outlier removal
  // Keeps only prices within [median×0.5 … median×2] — tight band, similar-segment vehicles
  const mid    = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const cleaned = sorted.filter(p => p >= median * 0.5 && p <= median * 2);
  if (!cleaned.length) return null;

  // Step 2: trim top/bottom 10%
  const cut     = cleaned.length > 6 ? Math.floor(cleaned.length * 0.10) : 0;
  const trimmed = cut ? cleaned.slice(cut, -cut) : cleaned;
  const avg     = Math.round(trimmed.reduce((s, p) => s + p, 0) / trimmed.length);

  return {
    min: cleaned[0], max: cleaned[cleaned.length - 1],
    avg, trimmedAvg: avg,
    count: trimmed.length, rawCount: prices.length,
  };
}

function estimateDays(fuelType, count) {
  const isPhev = /plug|phev|hybrid|enchufable/i.test(fuelType || '');
  if (isPhev) return count > 40 ? 35 : 25;
  return count > 100 ? 55 : count > 50 ? 42 : 35;
}

// ── POST /prices ─────────────────────────────────────────────
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

  const [wpRes, cnRes, asRes, mlRes] = await Promise.allSettled([
    fetchWallapop(car),
    fetchCochesNet(car),
    fetchAutoscout24(car),
    fetchMilanuncios(car),
  ]);

  const allPrices = [];
  const sources   = [];
  let   allItems  = [];

  for (const [r, name] of [[wpRes,'wallapop'],[cnRes,'coches.net'],[asRes,'autoscout24'],[mlRes,'milanuncios']]) {
    if (r.status === 'fulfilled' && r.value.prices.length) {
      allPrices.push(...r.value.prices);
      sources.push(name);
      if (r.value.items?.length) allItems = allItems.concat(r.value.items);
    } else if (r.status === 'rejected') {
      console.log(`[/prices] ${name} failed:`, r.reason?.message);
    }
  }

  console.log('[/prices] total prices:', allPrices.length, 'items:', allItems.length, 'from:', sources);

  if (!allPrices.length) {
    return res.status(404).json({
      error: 'No prices found',
      detail: {
        wallapop:    wpRes.reason?.message ?? 'ok but 0 prices',
        coches:      cnRes.reason?.message ?? 'ok but 0 prices',
        autoscout24: asRes.reason?.message ?? 'ok but 0 prices',
        milanuncios: mlRes.reason?.message ?? 'ok but 0 prices',
      },
    });
  }

  const stats = trimmedStats(allPrices);
  // Keep items whose price survived trimming (within [median/3, median*3])
  const sorted = [...allPrices].sort((a,b)=>a-b);
  const mid    = Math.floor(sorted.length/2);
  const median = sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
  // Show comparison cards closest to the median price (same segment)
  const filteredItems = allItems
    .filter(i => i.price >= median * 0.55 && i.price <= median * 1.8)
    .sort((a,b) => Math.abs(a.price - median) - Math.abs(b.price - median))
    .slice(0, 6);

  const data  = {
    ...stats,
    avgDaysToSell: estimateDays(car.fuelType, stats.rawCount),
    source: sources.join(' · '),
    items:  filteredItems,
    cached: false,
  };
  cache.set(key, { ts: Date.now(), data });
  res.json(data);
});

// ── GET /debug ────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const car = {
    make:    req.query.make    || 'Mercedes-Benz',
    model:   req.query.model   || 'C 300',
    year:    parseInt(req.query.year)    || 2018,
    mileage: parseInt(req.query.mileage) || 16500,
  };
  console.log('[/debug] car:', car);
  console.log('[/debug] coches.net slug:', slugify(car.make) + '-' + getCochesNetModelSlug(car.make, car.model));

  const [wpRes, cnRes, asRes, mlRes] = await Promise.allSettled([
    fetchWallapop(car),
    fetchCochesNet(car),
    fetchAutoscout24(car),
    fetchMilanuncios(car),
  ]);

  res.json({
    car,
    cochesNetSlug: slugify(car.make) + '-' + getCochesNetModelSlug(car.make, car.model),
    wallapop:    wpRes.status === 'fulfilled' ? { count: wpRes.value.prices.length, sample: wpRes.value.prices.slice(0,5) } : { error: wpRes.reason?.message },
    cochesNet:   cnRes.status === 'fulfilled' ? { count: cnRes.value.prices.length, sample: cnRes.value.prices.slice(0,5) } : { error: cnRes.reason?.message },
    autoscout24: asRes.status === 'fulfilled' ? { count: asRes.value.prices.length, sample: asRes.value.prices.slice(0,5), itemsCount: asRes.value.items?.length ?? 0, itemsSample: asRes.value.items?.slice(0,2) } : { error: asRes.reason?.message },
    milanuncios: mlRes.status === 'fulfilled' ? { count: mlRes.value.prices.length, sample: mlRes.value.prices.slice(0,5) } : { error: mlRes.reason?.message },
  });
});

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now(), version: '1.9' }));

app.post('/cache/clear', (_req, res) => { cache.clear(); res.json({ cleared: true }); });

app.listen(PORT, () => console.log(`Pegasus Scout backend v1.8 · port ${PORT}`));

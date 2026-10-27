// Cloudflare Worker: receives purchases from players' apps, validates them and appends them to the shared base
// library/purchases.json in the GitHub repository. The GitHub token lives only in the Worker's secrets (GITHUB_TOKEN),
// so neither the code nor the players' app holds anything secret.
//
// POST /submit  { "purchases": [ { t, soundId, size, label, price, itemId }, ... ] }  → { added }

const REPO = 'neverh8me/abi-kaluvan';
const BRANCH = 'main';
const BASE_PATH = 'library/purchases.json';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const BATCH = 25;              // the app sends no more than this at once
const BODY_MAX = 32 * 1024;    // bytes per request
const PER_HOUR = 12;           // requests per IP per hour
const LABELS = new Set(['', 'Mystery Cargo', 'Uncommon Mystery Cargo', 'Rare Mystery Cargo', 'Military Items', 'Medical Supplies',
  'Computer Parts', 'Collectibles', 'Instruments', 'Energy Items', 'Household Items', 'Building Materials',
  'Electronics', 'Flammables', 'Tools', 'Paper', 'Rare Collectibles', 'Uncommon Collectibles', 'Rare Medical Supplies', 'Uncommon Military Items']);
const RARITY = { 6: 'red', 5: 'gold', 4: 'purple', 3: 'blue', 2: 'green', 1: 'white' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/submit') return json({ ok: true, service: 'abi-kaluvan' });
    if (!env.GITHUB_TOKEN) return json({ error: 'not configured' }, 500);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await allow(ip, ctx))) return json({ error: 'too many requests' }, 429);

    const text = await request.text();
    if (text.length > BODY_MAX) return json({ error: 'too large' }, 413);
    let list;
    try { list = JSON.parse(text).purchases; } catch { return json({ error: 'bad json' }, 400); }
    if (!Array.isArray(list) || !list.length || list.length > BATCH) return json({ error: 'bad list' }, 400);

    const cat = await catalog();
    const clean = list.map(e => cleanEntry(e, cat)).filter(Boolean);
    // accepted: keys of the valid entries (new or already in the base); the app marks only these as sent
    const accepted = clean.map(key);
    if (!clean.length) return json({ added: 0, accepted });

    // append to the base on GitHub; if someone wrote at the same time (conflict), try again
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await gh(env, `contents/${BASE_PATH}?ref=${BRANCH}`);
      if (!cur.ok) return json({ error: 'github read ' + cur.status }, 502);
      const file = await cur.json();
      let base = [];
      try { base = JSON.parse(decode(file.content)).purchases || []; } catch {}
      const keys = new Set(base.map(key));
      const fresh = clean.filter(e => !keys.has(key(e)));
      if (!fresh.length) return json({ added: 0, accepted });
      const merged = base.concat(fresh).sort((a, b) => a.t - b.t);
      const body = JSON.stringify({ updated: new Date().toISOString(), purchases: merged }, null, 1) + '\n';
      const put = await gh(env, `contents/${BASE_PATH}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Add ${fresh.length} purchase${fresh.length > 1 ? 's' : ''} to the shared base`,
          content: encode(body), sha: file.sha, branch: BRANCH,
          committer: { name: 'abi-kaluvan-bot', email: 'abi-kaluvan-bot@users.noreply.github.com' },
        }),
      });
      if (put.ok) return json({ added: fresh.length, accepted });
      if (put.status !== 409 && put.status !== 422) return json({ error: 'github write ' + put.status }, 502);
    }
    return json({ error: 'busy, retry later' }, 503);
  },
};

// At most PER_HOUR requests per IP per hour (a counter in the Cloudflare cache)
async function allow(ip, ctx) {
  const cache = caches.default;
  const hour = Math.floor(Date.now() / 3600e3);
  const k = new Request(`https://rate.abi-kaluvan/${encodeURIComponent(ip)}/${hour}`);
  const hit = await cache.match(k);
  const n = hit ? +(await hit.text()) : 0;
  if (n >= PER_HOUR) return false;
  ctx.waitUntil(cache.put(k, new Response(String(n + 1), { headers: { 'Cache-Control': 'max-age=3600' } })));
  return true;
}

// Catalog from the repository: which items each sound can be, names, quality and pool prices
let cached = null, cachedAt = 0;
async function catalog() {
  if (cached && Date.now() - cachedAt < 3600e3) return cached;
  const [m, g] = await Promise.all(['library/merchant.json', 'library/groups.json']
    .map(p => fetch(RAW + p, { cf: { cacheTtl: 3600 } }).then(r => r.json())));
  const pairs = new Set(), names = new Map(), quals = new Map(), itemPools = new Map(); // itemPools: id → [{ label, price }]
  for (const it of m.items) { names.set(it.id, it.en); quals.set(it.id, RARITY[it.rarity] || ''); }
  for (const pl of m.pools) for (const [id] of pl.items) {
    if (!itemPools.has(id)) itemPools.set(id, []);
    itemPools.get(id).push({ label: pl.label || '', price: pl.price });
  }
  for (const grp of g.groups) {
    const up = grp.events.find(e => /_Up$/i.test(e)) || grp.events[0];
    const sid = 'lib:' + grp.id;
    for (const it of m.items) if (it.sound === up) pairs.add(`${sid}|${it.id}`);
    for (const it of grp.items) if (it.id) { pairs.add(`${sid}|${it.id}`); if (!names.has(it.id)) names.set(it.id, it.en); }
  }
  cached = { pairs, names, quals, itemPools };
  cachedAt = Date.now();
  return cached;
}

// Only known fields with plausible values, no free text (same as sync.ps1). A purchase without a sound
// (bought without dragging) still tells label + price → item: then the item must be in the pools of that label.
function cleanEntry(e, cat) {
  if (!e || typeof e !== 'object') return null;
  const t = Number(e.t), price = Number(e.price), itemId = Number(e.itemId);
  if (!(t >= 1735689600000 && t <= Date.now() + 86400e3)) return null;
  const label = LABELS.has(e.label) ? e.label : '';
  const soundId = typeof e.soundId === 'string' && e.soundId ? e.soundId : null;
  if (soundId ? !cat.pairs.has(`${soundId}|${itemId}`) : !label) return null;
  const priceOk = pp => price > 0 && Math.min(Math.abs(Math.log(price / pp)), Math.abs(Math.log(price / (pp * 1.1)))) <= 0.25;
  const plausible = (cat.itemPools.get(itemId) || []).some(p => (soundId || p.label === label) && priceOk(p.price));
  if (!plausible) return null;
  const size = typeof e.size === 'string' && /^[1-9]x[1-9]$/.test(e.size) ? e.size : '';
  return { t: Math.round(t), soundId, size, label, price: Math.round(price), itemId, item: cat.names.get(itemId) || '', q: cat.quals.get(itemId) || '' };
}

const key = e => `${e.t}|${e.itemId}|${e.price}`;

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'abi-kaluvan-worker', 'Content-Type': 'application/json',
    },
  });
}

function decode(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

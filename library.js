'use strict';
// Import of the "Proslushka" sound library: library/groups.json, merchant.json, names_ru.json and sounds/*.wav.
// groups.json: game sound → item group; merchant.json: Field Merchant pools with weights (abibuilder.com).
const Library = (() => {
  const RARITY = { 6: 'red', 5: 'gold', 4: 'purple', 3: 'blue', 2: 'green', 1: 'white' };

  // files: [{ path, blob }] — any path, matched by its ending
  async function load(files, decodeCtx, onProgress = () => {}) {
    const find = tail => files.find(f => f.path.replace(/\\/g, '/').toLowerCase().endsWith(tail.toLowerCase()));
    const readJson = async tail => {
      const f = find(tail);
      if (!f) throw new Error(`${tail} not found. Choose the "Proslushka" folder or its library folder.`);
      return JSON.parse(await f.blob.text());
    };
    const groups = (await readJson('groups.json')).groups;
    const merchant = await readJson('merchant.json');
    let names = {};
    try { names = (await readJson('names_ru.json')).names || {}; } catch {}

    const profiles = merchant.profiles.filter(p => p.maps && p.maps.length);
    const weights = itemWeights(merchant, profiles);
    // Mystery Cargo pools are mixed (items of different categories); cargo named after a category
    // ("Tools", "Paper"…) holds mostly that category (the rare category cargo can still hold a red)
    const catOf = new Map(merchant.items.map(it => [it.id, it.category]));
    const mixed = pl => new Set(pl.items.map(([id]) => catOf.get(id))).size > 1;
    const weightsMix = itemWeights(merchant, profiles, mixed);
    // Every pool carries the merchant label of its cargo ("Rare Mystery Cargo", "Rare Collectibles"…), so the
    // weights are also counted per label: the label read from a cargo then picks exactly its pools
    const labels = [...new Set(merchant.pools.map(pl => pl.label).filter(Boolean))];
    const weightsByLabel = new Map(labels.map(l => [l, itemWeights(merchant, profiles, pl => pl.label === l)]));
    const byId = new Map(merchant.items.map(it => [it.id, it]));

    const sounds = [];
    let done = 0;
    const total = groups.reduce((n, g) => n + g.sounds.length, 0);
    for (const g of groups) {
      const upEvent = g.events.find(e => /_Up$/i.test(e)) || g.events[0];
      // group items: from the merchant (it has weights), plus those only present in groups.json
      const ids = new Set(merchant.items.filter(it => it.sound === upEvent).map(it => it.id));
      for (const it of g.items) if (it.id) ids.add(it.id);
      const items = [...ids].map(id => {
        const m = byId.get(id) || {};
        const gi = g.items.find(x => x.id === id) || {};
        const en = m.en || gi.en || String(id);
        const wp = weights.get(id) || {}, wpm = weightsMix.get(id) || {};
        const avg = o => profiles.reduce((a, p) => a + (o[p.id] || 0), 0) / (profiles.length || 1);
        // per cargo label: { label: { profile: weight } } and the average over maps
        const wlp = {}, wl = {};
        for (const [l, map] of weightsByLabel) { const o = map.get(id); if (o) { wlp[l] = o; wl[l] = avg(o); } }
        return {
          id,
          name: names[en] || gi.ru || en,
          nameEn: en,
          q: RARITY[m.rarity || gi.rarity] || 'white',
          size: m.size || gi.size || '',
          price: m.ref || 0,        // approximate market price
          contact: m.contact || 0,  // price when handed in to a trader
          category: m.category || '',
          w: avg(wp),
          wp,
          wm: avg(wpm), // weight among Mystery Cargo only
          wpm,
          wl, wlp,      // weight among the pools of each cargo label

          img: `library/images/${id}.png`, // icons from abibuilder.com, stored in library/images
        };
      });

      // up — "pick up" templates (these are recognized), down — "put down" (such a sound is skipped).
      // Templates live only in memory: rebuilding them from wav is faster than storing them.
      const up = [], down = [];
      let dur = 0;
      for (const s of g.sounds) {
        onProgress(++done, total);
        const f = find(s.file);
        if (!f) continue;
        const res = await Ear.fileTemplate(await f.blob.arrayBuffer(), decodeCtx);
        if (!res) continue;
        if (s.kind === 'up' && !s.disabled) { up.push(res.tpl); dur = Math.max(dur, res.dur); }
        else if (s.kind !== 'up') down.push(res.tpl);
      }
      // English sound name — the three most frequent items of the group (groups.json has Russian names only)
      const nameEn = [...items].sort((a, b) => b.w - a.w).slice(0, 3).map(it => it.nameEn).join(', ');
      sounds.push({ id: 'lib:' + g.id, lib: true, name: g.title || g.id, nameEn, up, down, dur: +dur.toFixed(2), items });
    }
    // Merchant pools (for the tooltip price): price, weight, whether it is Mystery Cargo, items with weights
    const liveIds = new Set(profiles.map(p => p.id));
    const pools = merchant.pools.filter(pl => liveIds.has(pl.profile)).map(pl => ({
      profile: pl.profile, price: pl.price, weight: pl.weight, mixed: mixed(pl), label: pl.label || '',
      categories: [...new Set(pl.items.map(([id]) => catOf.get(id)))],
      items: pl.items.map(([id, w]) => [id, w]),
    }));
    const itemQ = {};
    for (const it of merchant.items) itemQ[it.id] = RARITY[it.rarity] || 'white';
    return {
      sounds,
      profiles: profiles.map(p => ({ id: p.id, name: p.maps.map(([map, mode]) => `${map} ${mode}`).join(', ') })),
      pools,
      itemQ,
    };
  }

  // Probability that a random merchant cargo holds the item, per profile (map + mode).
  // poolFilter — only cargo of a certain kind (for example Mystery Cargo).
  function itemWeights(merchant, profiles, poolFilter = () => true) {
    const out = new Map();
    for (const p of profiles) {
      const pools = merchant.pools.filter(pl => pl.profile === p.id && poolFilter(pl));
      const tw = pools.reduce((a, pl) => a + pl.weight, 0) || 1;
      for (const pl of pools) {
        const tiw = pl.items.reduce((a, [, w]) => a + w, 0) || 1;
        for (const [id, w] of pl.items) {
          if (!out.has(id)) out.set(id, {});
          const rec = out.get(id);
          rec[p.id] = (rec[p.id] || 0) + (pl.weight / tw) * (w / tiw);
        }
      }
    }
    return out;
  }

  return { load };
})();

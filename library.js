'use strict';
// Імпорт бібліотеки звуків «Прослушки»: library/groups.json, merchant.json, names_ru.json і sounds/*.wav.
// groups.json: звук гри → група предметів; merchant.json: пули полевого торговця з вагами (abibuilder.com).
const Library = (() => {
  const RARITY = { 6: 'red', 5: 'gold', 4: 'purple', 3: 'blue', 2: 'green', 1: 'white' };

  // files: [{ path, blob }] — шлях будь-який, шукаємо за кінцем
  async function load(files, decodeCtx, onProgress = () => {}) {
    const find = tail => files.find(f => f.path.replace(/\\/g, '/').toLowerCase().endsWith(tail.toLowerCase()));
    const readJson = async tail => {
      const f = find(tail);
      if (!f) throw new Error(`Не знайдено ${tail}. Вибери папку «Прослушка» або її папку library.`);
      return JSON.parse(await f.blob.text());
    };
    const groups = (await readJson('groups.json')).groups;
    const merchant = await readJson('merchant.json');
    let names = {};
    try { names = (await readJson('names_ru.json')).names || {}; } catch {}

    const profiles = merchant.profiles.filter(p => p.maps && p.maps.length);
    const weights = itemWeights(merchant, profiles);
    // Пули Mystery Cargo — змішані (предмети різних категорій); вантажі з назвою категорії
    // («Tools», «Paper»…) — однокатегорійні, і краснух у них не буває
    const catOf = new Map(merchant.items.map(it => [it.id, it.category]));
    const mixed = pl => new Set(pl.items.map(([id]) => catOf.get(id))).size > 1;
    const weightsMix = itemWeights(merchant, profiles, mixed);
    const byId = new Map(merchant.items.map(it => [it.id, it]));

    const sounds = [];
    let done = 0;
    const total = groups.reduce((n, g) => n + g.sounds.length, 0);
    for (const g of groups) {
      const upEvent = g.events.find(e => /_Up$/i.test(e)) || g.events[0];
      // предмети групи: з торговця (там ваги), плюс ті, що є лише в groups.json
      const ids = new Set(merchant.items.filter(it => it.sound === upEvent).map(it => it.id));
      for (const it of g.items) if (it.id) ids.add(it.id);
      const items = [...ids].map(id => {
        const m = byId.get(id) || {};
        const gi = g.items.find(x => x.id === id) || {};
        const en = m.en || gi.en || String(id);
        const wp = weights.get(id) || {}, wpm = weightsMix.get(id) || {};
        const avg = o => profiles.reduce((a, p) => a + (o[p.id] || 0), 0) / (profiles.length || 1);
        return {
          id,
          name: names[en] || gi.ru || en,
          nameEn: en,
          q: RARITY[m.rarity || gi.rarity] || 'white',
          size: m.size || gi.size || '',
          price: m.ref || 0,
          category: m.category || '',
          w: avg(wp),
          wp,
          wm: avg(wpm), // вага лише серед вантажів Mystery Cargo
          wpm,
          img: `library/images/${id}.png`, // іконки з abibuilder.com, лежать поруч у library/images
        };
      });

      // up — еталони «взяв» (їх і впізнаємо), down — «поклав» (такий звук пропускаємо).
      // Еталони живуть лише в памʼяті: їх швидше перебудувати з wav, ніж зберігати.
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
      // англійська назва звуку — три найчастіші предмети групи (у groups.json назви лише російські)
      const nameEn = [...items].sort((a, b) => b.w - a.w).slice(0, 3).map(it => it.nameEn).join(', ');
      sounds.push({ id: 'lib:' + g.id, lib: true, name: g.title || g.id, nameEn, up, down, dur: +dur.toFixed(2), items });
    }
    // Пули торговця (для ціни з рамки): ціна, вага, чи це Mystery Cargo, предмети з вагами
    const liveIds = new Set(profiles.map(p => p.id));
    const pools = merchant.pools.filter(pl => liveIds.has(pl.profile)).map(pl => ({
      profile: pl.profile, price: pl.price, weight: pl.weight, mixed: mixed(pl),
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

  // Імовірність, що випадковий вантаж торговця містить предмет, окремо для кожного профілю (карта + режим).
  // poolFilter — лише вантажі певного виду (наприклад, Mystery Cargo).
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

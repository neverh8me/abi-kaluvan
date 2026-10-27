'use strict';
// Reading text from the game picture: cargo labels in the merchant grid, the price tooltip, the feed and the balance.
// Tesseract (open-source OCR) is bundled in lib/tesseract, no internet needed.
const Ocr = (() => {
  const LABELS = [
    { key: 'raremysterycargo', mystery: 'rare' },
    { key: 'uncommonmysterycargo', mystery: 'uncommon' },
    { key: 'mysterycargo', mystery: 'common' },
    // name — exactly the merchant label of the pools (merchant.json "label"); rare/uncommon category cargo can hold reds
    { key: 'uncommonmilitaryitems', category: 'Miscellaneous Military Item', name: 'Uncommon Military Items' },
    { key: 'militaryitems', category: 'Miscellaneous Military Item', name: 'Military Items' },
    { key: 'raremedicalsupplies', category: 'Miscellaneous Medical Item', name: 'Rare Medical Supplies' },
    { key: 'medicalsupplies', category: 'Miscellaneous Medical Item', name: 'Medical Supplies' },
    { key: 'computerparts', category: 'Computer Parts', name: 'Computer Parts' },
    { key: 'rarecollectibles', category: 'Collectibles', name: 'Rare Collectibles' },
    { key: 'uncommoncollectibles', category: 'Collectibles', name: 'Uncommon Collectibles' },
    { key: 'collectibles', category: 'Collectibles', name: 'Collectibles' },
    { key: 'instruments', category: 'Instruments', name: 'Instruments' },
    { key: 'energyitems', category: 'Energy Items', name: 'Energy Items' },
    { key: 'householditems', category: 'Household Items', name: 'Household Items' },
    { key: 'buildingmaterials', category: 'Building Materials', name: 'Building Materials' },
    { key: 'electronics', category: 'Electronics', name: 'Electronics' },
    { key: 'flammables', category: 'Flammables', name: 'Flammables' },
    { key: 'tools', category: 'Tools', name: 'Tools' },
    { key: 'paper', category: 'Paper', name: 'Paper' },
  ];

  // Separate readers in their own threads: cargo labels (there are many of them) and the price tooltip
  // (it is needed right away while the cursor is on the cargo, so it does not wait behind the labels)
  const lanes = {};

  function lane(name) {
    if (!lanes[name]) {
      lanes[name] = {
        worker: Tesseract.createWorker('eng', 1, {
          workerPath: 'lib/tesseract/worker.min.js', corePath: 'lib/tesseract/', langPath: 'lib/tesseract',
          gzip: true, workerBlobURL: false,
        }),
        queue: Promise.resolve(),
      };
    }
    return lanes[name];
  }

  // Start all readers at once (after "Start catching"): otherwise the first price or the first labels
  // would also wait for the start-up (~0.4 s). Labels are read by two readers in parallel.
  function start() { return Promise.all(['label', 'label2', 'tip'].map(n => lane(n).worker)); }

  function read(canvas, name = 'label') {
    return readData(canvas, name).then(data => data.text);
  }

  // Full result: text and lines with words and boxes (bbox in canvas pixels).
  // One job at a time per reader: Tesseract is single-threaded anyway.
  function readData(canvas, name = 'tip') {
    const l = lane(name);
    const job = l.queue.then(async () => {
      const w = await l.worker;
      const { data } = await w.recognize(canvas);
      return data;
    });
    l.queue = job.catch(() => {});
    return job;
  }

  // Price tooltip: white text on near black. Scale it up and invert.
  // The game text has the same size in cells, and the cell size depends on resolution (1280×1024 ~40 px, 2K ~85 px).
  // Scale so that the text has the same height for Tesseract: at 64 px (1080p) — 2x.
  const TIP_SCALE = 2;
  const tipScale = P => (P ? Math.min(3, Math.max(1.25, 128 / P)) : TIP_SCALE);
  function tipCanvas(src, x, y, w, h, P) {
    const k = tipScale(P);
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.ocrScale = k;
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) invert(1) contrast(1.4)';
    ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  // The tooltip itself within a frame patch: the largest solid dark blob with light text. Grey cargo
  // with labels around it is not part of it, so the reader does not mix the price with other labels.
  // Returns { x, y, w, h } in src coordinates or null.
  const TIP_BLOCK = 4;
  function findTipBox(src, x, y, w, h, P) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    const sorted = Array.from(g).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const dark = Math.max(8, Math.min(30, median * 0.5)); // the tooltip background is darker than grey cargo
    // 4×4 blocks: "tooltip" ones are mostly dark, with almost no grey (grey is cargo)
    const bw = Math.floor(w / TIP_BLOCK), bh = Math.floor(h / TIP_BLOCK);
    const tipish = new Uint8Array(bw * bh), text = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let nd = 0, nm = 0, nb = 0;
        for (let yy = 0; yy < TIP_BLOCK; yy++) {
          for (let xx = 0; xx < TIP_BLOCK; xx++) {
            const v = g[(by * TIP_BLOCK + yy) * w + bx * TIP_BLOCK + xx];
            if (v < dark) nd++; else if (v > 150) nb++; else nm++;
          }
        }
        const n = TIP_BLOCK * TIP_BLOCK;
        tipish[by * bw + bx] = nd >= n * 0.4 && nm <= n * 0.35 ? 1 : 0;
        text[by * bw + bx] = nb > 0 ? 1 : 0;
      }
    }
    // the largest connected blob with text
    const seen = new Uint8Array(bw * bh);
    let best = null;
    for (let i = 0; i < tipish.length; i++) {
      if (!tipish[i] || seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let x0 = bw, y0 = bh, x1 = 0, y1 = 0, size = 0, withText = 0;
      while (stack.length) {
        const j = stack.pop(), jx = j % bw, jy = (j - jx) / bw;
        size++; withText += text[j];
        x0 = Math.min(x0, jx); y0 = Math.min(y0, jy); x1 = Math.max(x1, jx); y1 = Math.max(y1, jy);
        for (const k of [j - 1, j + 1, j - bw, j + bw]) {
          if (k < 0 || k >= tipish.length || seen[k] || !tipish[k]) continue;
          if ((k === j - 1 || k === j + 1) && Math.floor(k / bw) !== jy) continue;
          seen[k] = 1;
          stack.push(k);
        }
      }
      if (withText < 4) continue;
      if (!best || size > best.size) best = { size, x0, y0, x1, y1 };
    }
    if (!best) return null;
    const bx = best.x0 * TIP_BLOCK, by = best.y0 * TIP_BLOCK;
    const bw2 = (best.x1 + 1) * TIP_BLOCK - bx, bh2 = (best.y1 + 1) * TIP_BLOCK - by;
    if (bw2 < P * 1.2 || bh2 < P * 0.6) return null;
    return { x: x + bx, y: y + by, w: bw2, h: bh2 };
  }

  // A discounted tooltip shows two prices: "216,000 270,000" (the old one crossed out). Digit groups are split by
  // the same spaces or commas, so the regex glues them into one number. Take groups one by one while
  // each has exactly 3 digits with the same separator and the price is at most 7 digits (no cargo costs more
  // than 9,999,999). The first number is the current price, the second (if any) the old one.
  function splitPrices(text) {
    const parts = [...text.matchAll(/(\d+)([ ,.]?)/g)];
    const out = [];
    for (let i = 0; i < parts.length;) {
      let digits = parts[i][1];
      const sep = parts[i][2];
      for (i++; i < parts.length; i++) {
        const g = parts[i][1];
        if (g.length !== 3 || parts[i - 1][2] !== sep || (digits + g).length > 7) break;
        digits += g;
      }
      out.push(+digits);
    }
    return out;
  }

  // From the tooltip text: the cargo label (with the box of its line) and the price.
  // The price is a number with digit groups: "110,000", "470 000".
  function parseTip(data, k = TIP_SCALE) {
    const lines = (data.lines || []).map(l => ({ text: l.text.trim(), bbox: l.bbox, words: l.words }));
    let price = 0, listPrice = 0, priceAt = -1;
    lines.forEach((l, i) => {
      if (price) return;
      const t = l.text.replace(/[oO]/g, '0');
      const m = t.match(/(\d{1,3}(?:[ ,.]\d{3})+|\d{4,7})/);
      if (m) {
        // both prices from the rest of the line (the regex alone catches only the first one)
        const nums = splitPrices(t.slice(m.index)).filter(n => n >= 1000);
        price = nums[0]; listPrice = nums[1] > price ? nums[1] : 0; priceAt = i;
      }
    });
    if (!price || price < 1000) return null;
    // The label in the tooltip is the line right above the price. Labels of neighbouring cargo in the grid
    // may be caught higher up, so we go up from the price and take only the nearest line.
    const priceBox = lines[priceAt].bbox;
    let label = null, labelBox = null;
    const above = lines[priceAt - 1];
    if (above && priceBox.y0 - above.bbox.y1 < (priceBox.y1 - priceBox.y0) * 2.5) {
      // Tesseract may merge the label with a neighbouring cell's label at the same height: take only
      // the words above the price line (the tooltip label starts slightly left of the price)
      const lineH = priceBox.y1 - priceBox.y0;
      const words = (above.words || []).filter(wd => wd.bbox.x0 >= priceBox.x0 - lineH * 2.5);
      const text = words.length ? words.map(wd => wd.text).join(' ') : above.text;
      label = parseLabel(text);
      if (label) labelBox = words.length
        ? { x0: Math.min(...words.map(wd => wd.bbox.x0)), y0: Math.min(...words.map(wd => wd.bbox.y0)), x1: Math.max(...words.map(wd => wd.bbox.x1)), y1: Math.max(...words.map(wd => wd.bbox.y1)) }
        : above.bbox;
    }
    const scale = b => ({ x0: b.x0 / k, y0: b.y0 / k, x1: b.x1 / k, y1: b.y1 / k });
    return { price, listPrice, label, labelBox: labelBox && scale(labelBox), priceBox: scale(priceBox) };
  }

  // Cargo label at the top of a cell: crop, scale up and invert (Tesseract reads dark text on a
  // light background better). src — the frame, x/y/w/h — the cargo rectangle in it.
  function labelCanvas(src, x, y, w, h, P) {
    const lh = Math.min(h, P * 0.75), k = Math.min(4, Math.max(2, 192 / P)); // 3x at 64 px
    const c = document.createElement('canvas');
    c.width = Math.round((w - 4) * k); c.height = Math.round((lh - 4) * k);
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) invert(1) contrast(1.6)';
    ctx.drawImage(src, x + 2, y + 2, w - 4, lh - 4, 0, 0, c.width, c.height);
    return c;
  }

  // The closest known label. A label may be cut off ("Uncommo n Mus tory" in a narrow cell),
  // so it is compared with the start of a name of the same length. Returns the label description or null.
  function parseLabel(text) {
    const s = text.toLowerCase().replace(/[^a-z]/g, '');
    if (s.length < 4) return null;
    let best = null, bestScore = Infinity;
    for (const l of LABELS) {
      const target = l.key.slice(0, Math.min(l.key.length, s.length + 2));
      const d = distance(s.slice(0, target.length + 2), target) / target.length;
      // on an equal match take the longer name: "Rare Mystery Cargo", not "Mystery Cargo"
      if (d < bestScore - 0.02 || (Math.abs(d - bestScore) <= 0.02 && best && l.key.length > best.key.length)) { bestScore = d; best = l; }
    }
    return bestScore <= 0.4 ? best : null;
  }

  // Feed line above the grid: "neverh8me spent 200,000 Koen on a mystery cargo and obtained [Studio Monitor]".
  // The item name may be cut off by the panel edge. Returns { nick, price, item } or null.
  function parseFeed(text) {
    const s = text.replace(/\s+/g, ' ');
    // at low resolution "obtained" is read as "obloned", "obtomed" — "ob…" or a bracket is enough
    const m = s.match(/(\S+)\s+spent\s+([\d][\d ,.oO]*\d)\s*K\w*\s+on\b.*?(?:\bob\w*|(?=[\[({]))\s*[\[({|]?\s*([^\]\)}|]+)/i);
    if (!m) return null;
    const price = +m[2].replace(/[oO]/g, '0').replace(/\D/g, '');
    const item = m[3].replace(/[^A-Za-z0-9 .\-'&]/g, '').trim();
    if (!price || item.length < 3) return null;
    return { nick: m[1], price, item };
  }

  // Balance below the grid: "Owned: 624,605" (the Koen icon before the number is read as junk)
  function parseBalance(text) {
    const m = text.replace(/[oO](?=[\d,.]*\d)/g, '0').match(/wned\D{0,12}(\d{1,3}(?:[ ,.]\d{3})+|\d{1,9})/i);
    return m ? +m[1].replace(/\D/g, '') : 0;
  }

  // The closest name from a list of { name } (a name from the line may be cut off — then compare with the start).
  // Returns the list element or null.
  function matchName(text, list) {
    const norm = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s = norm(text);
    if (s.length < 3) return null;
    let best = null, bestScore = Infinity;
    for (const el of list) {
      const n = norm(el.name);
      if (!n) continue;
      // cut-off name: only the start; full name — the whole of it, so that "Gold" does not match "Gold Bar"
      const target = s.length < n.length ? n.slice(0, s.length) : n;
      const d = distance(s, target) / Math.max(s.length, target.length) + (s.length < n.length ? 0.01 : 0);
      if (d < bestScore) { bestScore = d; best = el; }
    }
    return bestScore <= 0.25 ? best : null;
  }

  function distance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }

  return { start, read, readData, labelCanvas, parseLabel, tipCanvas, findTipBox, parseTip, parseFeed, parseBalance, matchName };
})();

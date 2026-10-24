'use strict';
// Читання написів з картинки гри: назви вантажів у сітці торговця.
// Tesseract (відкритий OCR) лежить локально в lib/tesseract, інтернет не потрібен.
const Ocr = (() => {
  const LABELS = [
    { key: 'raremysterycargo', mystery: 'rare' },
    { key: 'uncommonmysterycargo', mystery: 'uncommon' },
    { key: 'mysterycargo', mystery: 'common' },
    { key: 'militaryitems', category: 'Miscellaneous Military Item', name: 'Military Items' },
    { key: 'medicalsupplies', category: 'Miscellaneous Medical Item', name: 'Medical Supplies' },
    { key: 'computerparts', category: 'Computer Parts', name: 'Computer Parts' },
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

  // Два розпізнавачі в окремих потоках: написи вантажів (їх багато) і рамка з ціною (вона потрібна
  // одразу, поки курсор на вантажі, тож не стоїть у черзі за написами)
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

  function start() { return lane('label').worker; }

  function read(canvas) {
    return readData(canvas, 'label').then(data => data.text);
  }

  // Повний результат: текст і рядки зі словами та прямокутниками (bbox у пікселях полотна).
  // У межах одного розпізнавача — по одному, Tesseract усе одно однопотоковий.
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

  // Рамка з ціною: білий текст на майже чорному. Збільшуємо вдвічі й інвертуємо.
  const TIP_SCALE = 2;
  function tipCanvas(src, x, y, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * TIP_SCALE); c.height = Math.round(h * TIP_SCALE);
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) invert(1) contrast(1.4)';
    ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  // Сама рамка в шматку кадру: найбільша суцільна темна пляма, де є світлий текст. Сірі вантажі
  // з написами довкола в неї не входять, тож розпізнавач не змішує ціну з чужими написами.
  // Повертає { x, y, w, h } у координатах src або null.
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
    const dark = Math.max(8, Math.min(30, median * 0.5)); // фон рамки темніший за сірі вантажі
    // блоки 4×4: «рамкові» — переважно темні, майже без сірого (сірий — це вантажі)
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
    // найбільша звʼязна пляма з текстом
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

  // З тексту рамки: назва вантажу (з прямокутником її рядка) і ціна.
  // Ціна — число з групами розрядів: «110,000», «470 000».
  function parseTip(data) {
    const lines = (data.lines || []).map(l => ({ text: l.text.trim(), bbox: l.bbox, words: l.words }));
    let price = 0, priceAt = -1;
    lines.forEach((l, i) => {
      if (price) return;
      const m = l.text.replace(/[oO]/g, '0').match(/(\d{1,3}(?:[ ,.]\d{3})+|\d{4,7})/);
      if (m) { price = +m[1].replace(/\D/g, ''); priceAt = i; }
    });
    if (!price || price < 1000) return null;
    // Назва в рамці — рядок одразу над ціною. Вище можуть потрапити написи сусідніх вантажів у сітці,
    // тож ідемо від ціни вгору й беремо лише найближчий рядок.
    const priceBox = lines[priceAt].bbox;
    let label = null, labelBox = null;
    const above = lines[priceAt - 1];
    if (above && priceBox.y0 - above.bbox.y1 < (priceBox.y1 - priceBox.y0) * 2.5) {
      // Tesseract може злити назву з написом сусідньої комірки на тій самій висоті: беремо лише
      // слова, що стоять над рядком ціни (назва в рамці починається трохи лівіше за ціну)
      const lineH = priceBox.y1 - priceBox.y0;
      const words = (above.words || []).filter(wd => wd.bbox.x0 >= priceBox.x0 - lineH * 2.5);
      const text = words.length ? words.map(wd => wd.text).join(' ') : above.text;
      label = parseLabel(text);
      if (label) labelBox = words.length
        ? { x0: Math.min(...words.map(wd => wd.bbox.x0)), y0: Math.min(...words.map(wd => wd.bbox.y0)), x1: Math.max(...words.map(wd => wd.bbox.x1)), y1: Math.max(...words.map(wd => wd.bbox.y1)) }
        : above.bbox;
    }
    const scale = b => ({ x0: b.x0 / TIP_SCALE, y0: b.y0 / TIP_SCALE, x1: b.x1 / TIP_SCALE, y1: b.y1 / TIP_SCALE });
    return { price, label, labelBox: labelBox && scale(labelBox), priceBox: scale(priceBox) };
  }

  // Напис вантажу у верхній частині комірки: вирізаємо, збільшуємо й інвертуємо (темний текст на
  // світлому Tesseract читає краще). src — кадр, x/y/w/h — прямокутник вантажу в ньому.
  function labelCanvas(src, x, y, w, h, P) {
    const lh = Math.min(h, P * 0.75), k = 3;
    const c = document.createElement('canvas');
    c.width = Math.round((w - 4) * k); c.height = Math.round((lh - 4) * k);
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) invert(1) contrast(1.6)';
    ctx.drawImage(src, x + 2, y + 2, w - 4, lh - 4, 0, 0, c.width, c.height);
    return c;
  }

  // Найближча відома назва. Напис може бути обрізаний («Uncommo n Mus tory» у вузькій комірці),
  // тож порівнюємо з початком назви тієї ж довжини. Повертає опис назви або null.
  function parseLabel(text) {
    const s = text.toLowerCase().replace(/[^a-z]/g, '');
    if (s.length < 4) return null;
    let best = null, bestScore = Infinity;
    for (const l of LABELS) {
      const target = l.key.slice(0, Math.min(l.key.length, s.length + 2));
      const d = distance(s.slice(0, target.length + 2), target) / target.length;
      // за рівного збігу беремо довшу назву: «Rare Mystery Cargo», а не «Mystery Cargo»
      if (d < bestScore - 0.02 || (Math.abs(d - bestScore) <= 0.02 && best && l.key.length > best.key.length)) { bestScore = d; best = l; }
    }
    return bestScore <= 0.4 ? best : null;
  }

  // Рядок стрічки над сіткою: «neverh8me spent 200,000 Koen on a mystery cargo and obtained [Studio Monitor]».
  // Назва предмета може бути обрізана краєм панелі. Повертає { nick, price, item } або null.
  function parseFeed(text) {
    const s = text.replace(/\s+/g, ' ');
    const m = s.match(/(\S+)\s+spent\s+([\d][\d ,.oO]*\d)\s*K\w*\s+on\b.*?obtain\w*\s*[\[({|]?\s*([^\]\)}|]+)/i);
    if (!m) return null;
    const price = +m[2].replace(/[oO]/g, '0').replace(/\D/g, '');
    const item = m[3].replace(/[^A-Za-z0-9 .\-'&]/g, '').trim();
    if (!price || item.length < 3) return null;
    return { nick: m[1], price, item };
  }

  // Баланс під сіткою: «Owned: 624,605» (перед числом — значок Koen, Tesseract читає його як сміття)
  function parseBalance(text) {
    const m = text.replace(/[oO](?=[\d,.]*\d)/g, '0').match(/wned\D{0,12}(\d{1,3}(?:[ ,.]\d{3})+|\d{1,9})/i);
    return m ? +m[1].replace(/\D/g, '') : 0;
  }

  // Найближча назва зі списку { name } (назва з рядка може бути обрізаною — тоді порівнюємо з початком).
  // Повертає елемент списку або null.
  function matchName(text, list) {
    const norm = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s = norm(text);
    if (s.length < 3) return null;
    let best = null, bestScore = Infinity;
    for (const el of list) {
      const n = norm(el.name);
      if (!n) continue;
      // обрізана назва: лише початок; повна — уся, щоб «Gold» не збігся з «Gold Bar»
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

'use strict';
// Розпізнавання сітки торговця на кадрі екрана. Чисті функції без DOM.
// Сітка: чорні комірки з тонкими світлими рамками; предмет займає кілька одиниць,
// а всередині предмета ліній між одиницями немає.
const Vision = (() => {
  const LINE_T = 10;        // наскільки лінія світліша за фон поруч
  const MIN_RUN = 12;       // мінімальна довжина відрізка лінії для пошуку періоду
  const EDGE_FILL = 0.55;   // частка межі, яку має покривати лінія (можна шматками)
  const EDGE_RUN = 0.25;    // і хоча б один суцільний шматок такої довжини
  const OCC_T = 40;         // яскравість, з якої піксель вважається «вмістом»
  const EDGE_REL = 0.7;     // межа вантажу — не слабша за таку частку від типової межі на кадрі

  function toGray(data, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    return { w, h, g };
  }

  // Наскільки піксель червоніший за інші канали (слід від потягнутого вантажу)
  function redness(data, w, h) {
    const r = new Uint8Array(w * h);
    for (let i = 0; i < r.length; i++) r[i] = Math.max(0, data[i * 4] - Math.max(data[i * 4 + 1], data[i * 4 + 2]));
    return r;
  }

  // Карти тонких світлих ліній: hr — горизонтальні, vr — вертикальні.
  // Сусідів беремо на відстані 2–4 px: на великій роздільності чи після масштабування лінія товща.
  // Лінія світліша за обидва боки; просто перепад (сірий вантаж → темний фон під списком) — не лінія.
  // У карті — контраст лінії (0 — не лінія): відкритий через Intel вантаж має кольоровий фон, і на ньому
  // видно лінії між клітинками всередині вантажу, але вдвічі слабші за справжні межі.
  // roi { x0, y0, x1, y1 } — шукати лише в цьому прямокутнику (довкола вже знайденої сітки): утричі швидше
  function lineMaps({ w, h, g }, roi) {
    const hr = new Uint8Array(w * h), vr = new Uint8Array(w * h);
    const D = 4;
    const contrast = (v, a, b) => Math.min(v - ((a + b) >> 1), 3 * (v - Math.max(a, b)));
    const xa = Math.max(D, roi ? Math.round(roi.x0) : 0), xb = Math.min(w - D, roi ? Math.round(roi.x1) : w);
    const ya = Math.max(D, roi ? Math.round(roi.y0) : 0), yb = Math.min(h - D, roi ? Math.round(roi.y1) : h);
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const i = y * w + x, v = g[i];
        let ch = 0, cv = 0;
        for (let d = 2; d <= D; d++) {
          ch = Math.max(ch, contrast(v, g[i - d * w], g[i + d * w]));
          cv = Math.max(cv, contrast(v, g[i - d], g[i + d]));
        }
        if (ch > LINE_T) hr[i] = Math.min(255, ch);
        if (cv > LINE_T) vr[i] = Math.min(255, cv);
      }
    }
    return { hr, vr };
  }

  // Профілі: частка довгих відрізків ліній у кожному рядку / стовпці
  function profiles(w, h, { hr, vr }, minRun = MIN_RUN) {
    const H = new Float32Array(h), V = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x <= w; x++) {
        if (x < w && hr[y * w + x]) { run++; continue; }
        if (run >= minRun) H[y] += run;
        run = 0;
      }
      H[y] /= w;
    }
    for (let x = 0; x < w; x++) {
      let run = 0;
      for (let y = 0; y <= h; y++) {
        if (y < h && vr[y * w + x]) { run++; continue; }
        if (run >= minRun) V[x] += run;
        run = 0;
      }
      V[x] /= h;
    }
    return { H: maxFilter(H), V: maxFilter(V) };
  }

  // Лише відрізки, не коротші за майже цілу клітинку: межі сітки такі завжди, а краї іконок і літер ні
  function gridProfiles(w, h, maps, P) {
    return profiles(w, h, maps, Math.max(MIN_RUN, Math.round(P * 0.8)));
  }

  // Розмір клітинки у два проходи: грубо, потім по довгих відрізках. На великій роздільності
  // краї іконки в центрі клітинки дають «лінії» посередині, і перший прохід може вийти вдвічі меншим.
  // Поріг 1.2 від грубої оцінки: якщо вона вдвічі менша, іконка (~0.55 клітинки) його не пройде.
  function detectPeriod(w, h, maps) {
    const P1 = findPeriod(profiles(w, h, maps));
    if (!P1) return null;
    return findPeriod(profiles(w, h, maps, Math.round(P1 * 1.2)), P1 * 0.9, P1 * 2.2) || P1;
  }

  // Лінія може бути на піксель зсунута: беремо максимум із сусідами
  function maxFilter(p) {
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = Math.max(p[i], p[i - 1] || 0, p[i + 1] || 0);
    return out;
  }

  function comb(p, P, phase) {
    let s = 0;
    for (let x = phase; x < p.length; x += P) s += p[Math.round(x)];
    return s;
  }

  function bestPhase(p, P) {
    let best = 0, bestS = -1;
    for (let ph = 0; ph < P; ph++) {
      const s = comb(p, P, ph);
      if (s > bestS) { bestS = s; best = ph; }
    }
    return { phase: best, score: bestS };
  }

  function mean(p) { let s = 0; for (const v of p) s += v; return s / p.length; }

  // Розмір одиниці сітки (у пікселях кадру)
  function findPeriod(prof, minP = 24, maxP = 220) {
    const { H, V } = prof;
    maxP = Math.min(maxP, H.length / 2, V.length / 2);
    const score = periodScorer(prof);
    let best = null, top = 0;
    for (let P = minP; P <= maxP; P += 0.25) {
      const s = score(P);
      if (s > top) { top = s; best = P; }
    }
    return best && top > 0.05 ? best : null;
  }

  // Бал періоду — сума перевищень над середнім у всіх «зубцях» гребінки. Сума, а не середнє:
  // великий період має лише кілька зубців і не може виграти, влучивши в пару рамок панелі,
  // а кратний період (×2) збирає лише половину ліній.
  function periodScorer({ H, V }) {
    const eH = excess(H), eV = excess(V);
    return P => bestPhase(eH, P).score + bestPhase(eV, P).score;
  }

  function excess(p) {
    const m = mean(p);
    return p.map(v => v - m);
  }

  // Положення сітки при відомому періоді
  function locate(prof, P) {
    const { H, V } = prof;
    const px = bestPhase(V, P).phase, py = bestPhase(H, P).phase;
    const span = (p, ph) => {
      const ks = [];
      for (let x = ph, k = 0; x < p.length; x += P, k++) ks.push(p[Math.round(x)]);
      const mx = Math.max(...ks);
      let a = ks.findIndex(v => v >= 0.3 * mx), b = ks.length - 1;
      while (b > a && ks[b] < 0.3 * mx) b--;
      return [a, b];
    };
    const [c0, c1] = span(V, px), [r0, r1] = span(H, py);
    if (c1 - c0 < 1 || r1 - r0 < 1) return null;
    // точний розмір: похибка навіть у 0.2 px на 9 клітинках зсуває перевірку меж повз лінії
    const fx = fitLines(V, px + c0 * P, P, c1 - c0), fy = fitLines(H, py + r0 * P, P, r1 - r0);
    const fits = [fx, fy].filter(Boolean);
    const Pf = fits.length ? fits.reduce((a, f) => a + f.P * f.n, 0) / fits.reduce((a, f) => a + f.n, 0) : P;
    return { P: Pf, x0: fx ? fx.x0 : px + c0 * P, y0: fy ? fy.x0 : py + r0 * P, cols: c1 - c0, rows: r1 - r0 };
  }

  // Знаходить справжні піки ліній біля очікуваних позицій start + k*P і підганяє пряму pos = x0 + k*P
  function fitLines(p, start, P, count) {
    const pts = [];
    for (let k = 0; k <= count; k++) {
      const e = Math.round(start + k * P);
      let best = -1, bestV = 0;
      for (let x = e - 3; x <= e + 3; x++) if (p[x] > bestV) { bestV = p[x]; best = x; }
      if (best >= 0 && bestV > 0) {
        // центр піку (лінія може бути 2 px завтовшки)
        let s = 0, sw = 0;
        for (let x = best - 2; x <= best + 2; x++) if (p[x] >= bestV * 0.6) { s += x * p[x]; sw += p[x]; }
        pts.push([k, s / sw]);
      }
    }
    if (pts.length < 3) return null;
    const n = pts.length, mk = pts.reduce((a, [k]) => a + k, 0) / n, mx = pts.reduce((a, [, x]) => a + x, 0) / n;
    let num = 0, den = 0;
    for (const [k, x] of pts) { num += (k - mk) * (x - mx); den += (k - mk) ** 2; }
    const slope = num / den;
    if (!(Math.abs(slope - P) < P * 0.05)) return null;
    return { P: slope, x0: mx - slope * mk, n };
  }

  // Чи є лінія вздовж межі. Довгий напис («Uncommon Mystery Cargo» у 4 рядки) перекриває рамку
  // й рве її на шматки, тож дивимось на сумарне покриття, а не лише на найдовший шматок.
  // minC — найменший контраст, що рахується.
  function edgeFill(map, w, x, y, len, horizontal, minC = 1) {
    let best = 0, run = 0, hits = 0;
    for (let i = 0; i < len; i++) {
      let hit = false;
      for (let d = -2; d <= 2 && !hit; d++) {
        const idx = horizontal ? (y + d) * w + (x + i) : (y + i) * w + (x + d);
        if (map[idx] >= minC) hit = true;
      }
      if (hit) hits++;
      run = hit ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best >= len * EDGE_RUN ? hits / len : 0;
  }

  // Сила лінії вздовж межі: медіана найсильнішого контрасту поперек лінії в кожній точці, де вона є
  function edgeStrength(map, w, x, y, len, horizontal) {
    const vals = [];
    for (let i = 0; i < len; i++) {
      let m = 0;
      for (let d = -2; d <= 2; d++) m = Math.max(m, map[horizontal ? (y + d) * w + (x + i) : (y + i) * w + (x + d)]);
      if (m) vals.push(m);
    }
    if (vals.length < len * EDGE_FILL) return 0;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  }

  // Предмети на кадрі: [{ c, r, w, h, occ }] в одиницях сітки (r від верхньої видимої лінії)
  function segment(G, maps, grid) {
    const { w } = G;
    const { P, x0, y0, cols, rows } = grid;
    const X = c => Math.round(x0 + c * P), Y = r => Math.round(y0 + r * P);
    const pad = Math.round(P * 0.12), len = Math.round(P) - 2 * pad;
    // Типова межа — медіана сили всіх ліній сітки (переважно це межі вантажів і порожніх клітинок).
    // Слабші за EDGE_REL від неї — лінії всередині відкритого вантажу, а не його межі.
    const strengths = [];
    for (let r = 0; r < rows; r++) for (let k = 0; k <= cols; k++) strengths.push(edgeStrength(maps.vr, w, X(k), Y(r) + pad, len, false));
    for (let c = 0; c < cols; c++) for (let k = 0; k <= rows; k++) strengths.push(edgeStrength(maps.hr, w, X(c) + pad, Y(k), len, true));
    const strong = strengths.filter(Boolean).sort((a, b) => a - b);
    const minC = strong.length ? Math.max(1, strong[strong.length >> 1] * EDGE_REL) : 1;
    const vLine = (k, r) => edgeFill(maps.vr, w, X(k), Y(r) + pad, len, false, minC) >= EDGE_FILL;
    const hLine = (c, k) => edgeFill(maps.hr, w, X(c) + pad, Y(k), len, true, minC) >= EDGE_FILL;

    // об'єднуємо сусідні одиниці без лінії між ними
    const parent = Array.from({ length: cols * rows }, (_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const join = (a, b) => { parent[find(a)] = find(b); };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols && !vLine(c + 1, r)) join(r * cols + c, r * cols + c + 1);
        if (r + 1 < rows && !hLine(c, r + 1)) join(r * cols + c, (r + 1) * cols + c);
      }
    }

    const groups = new Map();
    for (let i = 0; i < cols * rows; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }

    const items = [];
    for (const cells of groups.values()) {
      const cs = cells.map(i => i % cols), rs = cells.map(i => Math.floor(i / cols));
      const c = Math.min(...cs), r = Math.min(...rs);
      const iw = Math.max(...cs) - c + 1, ih = Math.max(...rs) - r + 1;
      if (cells.length !== iw * ih) continue;            // не прямокутник: помилка, пропускаємо
      if (iw > 4 || ih > 4) continue;                    // таких великих вантажів не буває
      // усі зовнішні межі мають бути лініями, інакше предмет обрізаний прокруткою
      let closed = true;
      for (let k = 0; k < iw && closed; k++) closed = hLine(c + k, r) && hLine(c + k, r + ih);
      for (let k = 0; k < ih && closed; k++) closed = vLine(c, r + k) && vLine(c + iw, r + k);
      if (!closed) continue;
      items.push({ c, r, w: iw, h: ih, occ: occupancy(G, X(c), Y(r), X(c + iw) - X(c), Y(r + ih) - Y(r)) });
    }
    return items;
  }

  // Сітка і вантажі при відомому розмірі клітинки. Якщо розмір вийшов удвічі меншим за справжній,
  // межі вантажів усе одно знаходяться, але кожен вантаж має парні розміри на парних позиціях:
  // тоді подвоюємо клітинку й розбираємо ще раз. Повертає { P, grid, items } або null.
  function analyze(G, maps, P) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const grid = locate(gridProfiles(G.w, G.h, maps, P), P);
      if (!grid || grid.cols < 2 || grid.rows < 2) return null;
      const items = segment(G, maps, grid);
      if (items.length < 4 || !looksHalved(items)) return { P: grid.P, grid, items };
      P = grid.P * 2;
    }
    return null;
  }

  function looksHalved(items) {
    const pc = items[0].c % 2, pr = items[0].r % 2;
    const even = items.filter(it => it.w % 2 === 0 && it.h % 2 === 0 && it.c % 2 === pc && it.r % 2 === pr);
    return even.length >= items.length * 0.85;
  }

  // Смуга прокрутки праворуч від сітки: тьмяна доріжка на всю висоту списку і світлий повзунок.
  // Повертає { x, trackTop, trackLen, thumbTop, thumbLen } у пікселях кадру або null.
  // known — доріжка, знайдена раніше: тоді шукаємо лише повзунок на ній.
  function scrollbar({ w, h, g }, grid, known) {
    if (known) return thumbOn({ w, h, g }, known);
    const right = Math.round(grid.x0 + grid.cols * grid.P);
    let best = null;
    for (let x = right + 2; x < Math.min(w - 4, right + grid.P * 0.5); x++) {
      // наскільки стовпчик світліший за фон праворуч від нього
      const diff = y => g[y * w + x] - g[y * w + x + 4];
      const track = longestRun(h, y => diff(y) > 10);
      if (!track || track.len < grid.P * 2) continue;
      // повзунок — помітно світліший за саму доріжку (рівень доріжки — медіана стовпчика)
      const vals = [];
      for (let y = track.start; y < track.start + track.len; y++) vals.push(g[y * w + x]);
      vals.sort((a, b) => a - b);
      const med = vals[vals.length >> 1], top = vals[vals.length - 1];
      if (top - med < 20) {
        // повзунок на всю доріжку: список уміщається без прокрутки
        if (!best) best = { x, trackTop: track.start, trackLen: track.len, thumbTop: track.start, thumbLen: track.len };
        continue;
      }
      const cut = med + (top - med) * 0.5;
      const thumb = longestRun(h, y => y >= track.start && y < track.start + track.len && g[y * w + x] > cut);
      if (!thumb || thumb.len < grid.P * 0.5) continue;
      if (!best || track.len > best.trackLen) best = { x, trackTop: track.start, trackLen: track.len, thumbTop: thumb.start, thumbLen: thumb.len };
    }
    return best;
  }

  // Повзунок на відомій доріжці: найсвітліший відрізок стовпчика в її межах (±1 px по x)
  function thumbOn({ w, h, g }, k) {
    if (k.thumbLen >= k.trackLen - 2) return k; // список без прокрутки
    let best = null;
    for (let x = k.x - 1; x <= k.x + 1; x++) {
      if (x < 0 || x >= w) continue;
      const vals = [];
      for (let y = k.trackTop; y < k.trackTop + k.trackLen && y < h; y++) vals.push(g[y * w + x]);
      if (vals.length < 10) continue;
      const sorted = vals.slice().sort((a, b) => a - b);
      const lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[sorted.length - 1];
      if (hi - lo < 20) continue;
      const cut = lo + (hi - lo) * 0.5;
      const run = longestRun(vals.length, i => vals[i] > cut);
      if (!run || run.len < 8) continue;
      if (!best || run.len > best.thumbLen) best = { x: k.x, trackTop: k.trackTop, trackLen: k.trackLen, thumbTop: k.trackTop + run.start, thumbLen: run.len };
    }
    return best;
  }

  // Найдовший відрізок, де pred(y) істинний (з пропусками до 2 px)
  function longestRun(h, pred) {
    let best = null, start = -1, gap = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && pred(y)) { if (start < 0) start = y; gap = 0; continue; }
      if (start >= 0 && y < h && ++gap <= 2) continue;
      if (start >= 0) {
        const len = y - gap - start;
        if (!best || len > best.len) best = { start, len };
      }
      start = -1; gap = 0;
    }
    return best;
  }

  // Середній колір прямокутника (RGBA-дані кадру), для вантажів, розкритих розвідданими
  function meanColor(data, w, x, y, rw, rh) {
    let r = 0, gg = 0, b = 0, n = 0;
    const step = Math.max(1, Math.round(Math.min(rw, rh) / 16));
    for (let yy = Math.round(y); yy < y + rh; yy += step) {
      for (let xx = Math.round(x); xx < x + rw; xx += step) {
        const i = (yy * w + xx) * 4;
        r += data[i]; gg += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return n ? [r / n, gg / n, b / n] : [0, 0, 0];
  }

  // Частка «непорожніх» пікселів усередині прямокутника (текст, іконка)
  function occupancy({ w, g }, x, y, rw, rh) {
    const inset = 4; // лише рамка; назва предмета притиснута до верхнього краю
    let n = 0, hit = 0;
    for (let yy = y + inset; yy < y + rh - inset; yy++) {
      for (let xx = x + inset; xx < x + rw - inset; xx++) { n++; if (g[yy * w + xx] > OCC_T) hit++; }
    }
    return n ? hit / n : 0;
  }

  // Вертикальний зсув вмісту між двома маленькими кадрами: cur(y) ≈ prev(y + d)
  function estimateShift(prev, cur, w, h, maxS) {
    let best = 0, bestCost = Infinity;
    for (let d = -maxS; d <= maxS; d++) {
      const y0 = Math.max(0, -d), y1 = Math.min(h, h - d);
      if (y1 - y0 < h * 0.35) continue;
      let cost = 0;
      for (let y = y0; y < y1; y++) {
        const a = y * w, b = (y + d) * w;
        for (let x = 0; x < w; x++) cost += Math.abs(cur[a + x] - prev[b + x]);
      }
      cost = cost / ((y1 - y0) * w) + Math.abs(d) * 0.01;
      if (cost < bestCost) { bestCost = cost; best = d; }
    }
    return { d: best, cost: bestCost };
  }

  // Середня різниця двох однакових за розміром фрагментів
  function patchDiff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return a.length ? s / a.length : 0;
  }

  function meanOf(a) {
    let s = 0;
    for (const v of a) s += v;
    return a.length ? s / a.length : 0;
  }

  function crop({ w, g }, x, y, cw, ch) {
    const out = new Uint8Array(cw * ch);
    for (let yy = 0; yy < ch; yy++) out.set(g.subarray((y + yy) * w + x, (y + yy) * w + x + cw), yy * cw);
    return out;
  }

  return { toGray, redness, lineMaps, profiles, gridProfiles, detectPeriod, findPeriod, periodScorer, locate, analyze, scrollbar, meanColor, segment, estimateShift, patchDiff, meanOf, crop };
})();

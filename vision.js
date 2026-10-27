'use strict';
// Merchant grid recognition on a screen frame. Pure functions, no DOM.
// The grid: black cells with thin light borders; an item spans several cells,
// and there are no lines between the cells inside an item.
const Vision = (() => {
  const LINE_T = 10;        // how much brighter a line is than the background next to it
  const MIN_RUN = 12;       // minimal line segment length for the period search
  const EDGE_FILL = 0.55;   // share of an edge the line has to cover (may be in pieces)
  const EDGE_RUN = 0.25;    // plus at least one solid piece of this length
  // Brightness from which a pixel counts as "content", per frame: the darkest level of the grid (empty slots)
  // plus a margin. Empty slots are ~30 and cargo ~60 on a normal picture, but ~0–7 and ~18 with a dark
  // in-game picture (gamma/brightness), so a fixed threshold misses all cargo there.
  const OCC_MARGIN = 8, OCC_MIN = 10, OCC_MAX = 40;
  const EDGE_REL = 0.6;     // a cargo border is at least this share of the frame's typical border (lines inside revealed cargo ~0.5)
  const EDGE_SAME = 0.9;    // between two cells of the same revealed color, a border must be this strong (inner lines ~0.5–0.6)
  const SAT_MIN = 22;       // a revealed background is this saturated (max−min of RGB): gold ~86, purple ~36, grey cargo ~3
  const COLOR_NEAR = 40;    // two strips of this RGB distance are the same background
  const OUTER_FILL = 0.35;  // the left/right edges of the whole list may be covered more (cursor, tooltip, scrollbar thumb)

  function toGray(data, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    return { w, h, g, rgba: data }; // the color data stays at hand for the revealed cargo check in segment
  }

  // How much redder a pixel is than the other channels (the trace of a dragged cargo)
  function redness(data, w, h) {
    const r = new Uint8Array(w * h);
    for (let i = 0; i < r.length; i++) r[i] = Math.max(0, data[i * 4] - Math.max(data[i * 4 + 1], data[i * 4 + 2]));
    return r;
  }

  // Maps of thin light lines: hr — horizontal, vr — vertical.
  // Neighbours are taken 2–4 px away: at high resolution or after scaling a line is thicker.
  // A line is brighter than both sides; a plain step (grey cargo → dark background below the list) is not a line.
  // The map holds the line contrast (0 — no line): cargo revealed via Intel has a colored background with
  // visible lines between its cells, but they are about half as strong as real borders.
  // roi { x0, y0, x1, y1 } — search only inside this rectangle (around the grid already found): 3x faster
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

  // Profiles: share of long line segments in each row / column
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

  // Only segments almost a whole cell long: grid borders always are, icon and letter edges are not
  function gridProfiles(w, h, maps, P) {
    return profiles(w, h, maps, Math.max(MIN_RUN, Math.round(P * 0.8)));
  }

  // Cell size in two passes: rough, then from long segments only. At high resolution icon edges
  // in the middle of a cell look like "lines" there, and the first pass may come out half as large.
  // The 1.2 threshold of the rough estimate: if it is half the size, an icon (~0.55 cell) will not pass it.
  function detectPeriod(w, h, maps) {
    const P1 = findPeriod(profiles(w, h, maps));
    if (!P1) return null;
    return findPeriod(profiles(w, h, maps, Math.round(P1 * 1.2)), P1 * 0.9, P1 * 2.2) || P1;
  }

  // A line may be shifted by a pixel: take the max with the neighbours
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

  // Grid cell size (in frame pixels)
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

  // Period score — the sum of excesses over the mean at all comb teeth. A sum, not a mean:
  // a large period has only a few teeth and cannot win by hitting a couple of panel borders,
  // and a multiple period (×2) collects only half of the lines.
  function periodScorer({ H, V }) {
    const eH = excess(H), eV = excess(V);
    return P => bestPhase(eH, P).score + bestPhase(eV, P).score;
  }

  function excess(p) {
    const m = mean(p);
    return p.map(v => v - m);
  }

  // Grid position for a known period
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
    // exact size: even a 0.2 px error over 9 cells moves the edge checks past the lines
    const fx = fitLines(V, px + c0 * P, P, c1 - c0), fy = fitLines(H, py + r0 * P, P, r1 - r0);
    const fits = [fx, fy].filter(Boolean);
    const Pf = fits.length ? fits.reduce((a, f) => a + f.P * f.n, 0) / fits.reduce((a, f) => a + f.n, 0) : P;
    const x0 = fx ? fx.x0 : px + c0 * P, y0 = fy ? fy.x0 : py + r0 * P;
    // At low resolution (1280×720, 1280×1024) a cell is ~40 px, and even 0.2 px of error over 9 columns
    // moves the outer lines past the real ones. So every line is pulled to the peak next to it.
    return { P: Pf, x0, y0, cols: c1 - c0, rows: r1 - r0, xs: snapLines(V, x0, Pf, c1 - c0), ys: snapLines(H, y0, Pf, r1 - r0) };
  }

  // Exact line positions k = 0..count: the profile peak near x0 + k*P, or the computed one where no peak is seen
  function snapLines(p, x0, P, count) {
    const r = Math.max(2, Math.round(P * 0.06));
    const peaks = [];
    for (let k = 0; k <= count; k++) {
      const e = Math.round(x0 + k * P);
      let best = e, bestV = 0;
      for (let x = e - r; x <= e + r; x++) if (p[x] > bestV) { bestV = p[x]; best = x; }
      peaks.push({ e, best, v: bestV });
    }
    const vs = peaks.map(q => q.v).sort((a, b) => a - b), med = vs[vs.length >> 1];
    return peaks.map(q => {
      if (!(q.v >= med * 0.35) || !q.v) return q.e;
      let s = 0, sw = 0;
      for (let x = q.best - 2; x <= q.best + 2; x++) if (p[x] >= q.v * 0.6) { s += x * p[x]; sw += p[x]; }
      return Math.round(s / sw);
    });
  }

  // Finds the real line peaks near the expected positions start + k*P and fits the line pos = x0 + k*P
  function fitLines(p, start, P, count) {
    const pts = [];
    for (let k = 0; k <= count; k++) {
      const e = Math.round(start + k * P);
      let best = -1, bestV = 0;
      for (let x = e - 3; x <= e + 3; x++) if (p[x] > bestV) { bestV = p[x]; best = x; }
      if (best >= 0 && bestV > 0) {
        // peak center (a line may be 2 px thick)
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

  // Whether there is a line along an edge. A long label ("Uncommon Mystery Cargo" in 4 lines) covers the border
  // and tears it into pieces, so we look at the total coverage, not only at the longest piece.
  // minC — the smallest contrast that counts.
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

  // Line strength along an edge: the median of the strongest cross-line contrast at every point where it exists
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

  // Items in a frame: [{ c, r, w, h, occ }] in grid units (r from the top visible line)
  function segment(G, maps, grid) {
    const { w } = G;
    const { P, x0, y0, cols, rows } = grid;
    const X = c => (grid.xs && grid.xs[c] !== undefined ? grid.xs[c] : Math.round(x0 + c * P));
    const Y = r => (grid.ys && grid.ys[r] !== undefined ? grid.ys[r] : Math.round(y0 + r * P));
    const pad = Math.round(P * 0.12), len = Math.round(P) - 2 * pad;
    // The typical border is the median strength of all grid lines (mostly cargo and empty cell borders).
    // Lines weaker than EDGE_REL of it are lines inside a revealed cargo, not its borders.
    const strengths = [];
    for (let r = 0; r < rows; r++) for (let k = 0; k <= cols; k++) strengths.push(edgeStrength(maps.vr, w, X(k), Y(r) + pad, len, false));
    for (let c = 0; c < cols; c++) for (let k = 0; k <= rows; k++) strengths.push(edgeStrength(maps.hr, w, X(c) + pad, Y(k), len, true));
    const strong = strengths.filter(Boolean).sort((a, b) => a - b);
    const minC = strong.length ? Math.max(1, strong[strong.length >> 1] * EDGE_REL) : 1;
    // the brightness of empty slots on this frame (see darkLevel): content is anything brighter
    const occT = darkLevel(G, X, Y, cols, rows);
    // Inside a revealed cargo both sides of a line have the same saturated background (gold, purple…), while a
    // real border separates different cargo. Between two such same-colored cells only a very strong line counts:
    // that still splits two different cargo of the same quality, whose shared border is bright.
    const strongC = strong.length ? strong[strong.length >> 1] * EDGE_SAME : Infinity;
    const off = Math.max(3, Math.round(P * 0.08)), band = Math.max(3, Math.round(P * 0.12));
    const sameColor = (ax, ay, bx, by, horizontal) => {
      const a = stripColor(G, ax, ay, horizontal ? len : band, horizontal ? band : len);
      const b = stripColor(G, bx, by, horizontal ? len : band, horizontal ? band : len);
      return !!(a && b && a.s >= SAT_MIN && b.s >= SAT_MIN && colorDist(a, b) < COLOR_NEAR);
    };
    // the left and right edges of the whole list are always borders, but the cursor, a price tooltip or the
    // scrollbar thumb next to them cover them more often: a smaller coverage is enough there
    const vLine = (k, r) => {
      const x = X(k), y = Y(r) + pad;
      if (k > 0 && k < cols && sameColor(x - off - band, y, x + off, y, false)) return edgeStrength(maps.vr, w, x, y, len, false) >= strongC;
      return edgeFill(maps.vr, w, x, y, len, false, minC) >= (k === 0 || k === cols ? OUTER_FILL : EDGE_FILL);
    };
    const hLine = (c, k) => {
      const x = X(c) + pad, y = Y(k);
      if (k > 0 && k < rows && sameColor(x, y - off - band, x, y + off, true)) return edgeStrength(maps.hr, w, x, y, len, true) >= strongC;
      return edgeFill(maps.hr, w, x, y, len, true, minC) >= EDGE_FILL;
    };

    // merge neighbouring cells with no line between them
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
      if (cells.length !== iw * ih) continue;            // not a rectangle: an error, skip
      if (iw > 4 || ih > 4) continue;                    // cargo this large does not exist
      // all outer edges must be lines, otherwise the item is cut off by scrolling
      let closed = true;
      for (let k = 0; k < iw && closed; k++) closed = hLine(c + k, r) && hLine(c + k, r + ih);
      for (let k = 0; k < ih && closed; k++) closed = vLine(c, r + k) && vLine(c + iw, r + k);
      if (!closed) continue;
      items.push({ c, r, w: iw, h: ih, occ: occupancy(G, X(c), Y(r), X(c + iw) - X(c), Y(r + ih) - Y(r), occT) });
    }
    return items;
  }

  // Grid and cargo for a known cell size. If the size came out half the real one,
  // cargo borders are still found, but every cargo has even sizes at even positions:
  // then the cell is doubled and the frame is parsed again. Returns { P, grid, items } or null.
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

  // Scrollbar to the right of the grid: a dim track the full height of the list and a light thumb.
  // Returns { x, trackTop, trackLen, thumbTop, thumbLen } in frame pixels or null.
  // known — a track found earlier: then only the thumb on it is searched.
  function scrollbar({ w, h, g }, grid, known) {
    if (known) return thumbOn({ w, h, g }, known);
    const right = Math.round(grid.x0 + grid.cols * grid.P);
    let best = null;
    for (let x = right + 2; x < Math.min(w - 4, right + grid.P * 0.5); x++) {
      // how much brighter the column is than the background to its right
      const diff = y => g[y * w + x] - g[y * w + x + 4];
      const track = longestRun(h, y => diff(y) > 10);
      if (!track || track.len < grid.P * 2) continue;
      // the thumb is noticeably brighter than the track itself (track level — the column median)
      const vals = [];
      for (let y = track.start; y < track.start + track.len; y++) vals.push(g[y * w + x]);
      vals.sort((a, b) => a - b);
      const med = vals[vals.length >> 1], top = vals[vals.length - 1];
      if (top - med < 20) {
        // thumb over the whole track: the list fits without scrolling
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

  // Thumb on a known track: the brightest stretch of the column within it (±1 px in x)
  function thumbOn({ w, h, g }, k) {
    if (k.thumbLen >= k.trackLen - 2) return k; // list without scrolling
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

  // The longest stretch where pred(y) is true (with gaps up to 2 px)
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

  // Mean color of a rectangle (RGBA frame data), for cargo revealed by intel
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

  // Mean color and saturation of a strip next to a grid line, or null without color data / outside the frame.
  // The median per channel: an item picture in a revealed cargo covers part of the strip.
  function stripColor({ w, h, rgba }, x, y, sw, sh) {
    if (!rgba || x < 0 || y < 0 || x + sw > w || y + sh > h) return null;
    const R = [], Gc = [], B = [];
    for (let yy = y; yy < y + sh; yy += 2) {
      for (let xx = x; xx < x + sw; xx += 2) { const i = (yy * w + xx) * 4; R.push(rgba[i]); Gc.push(rgba[i + 1]); B.push(rgba[i + 2]); }
    }
    if (!R.length) return null;
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    const c = { r: med(R), g: med(Gc), b: med(B) };
    c.s = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    return c;
  }

  function colorDist(a, b) {
    return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  }

  // Share of "non-empty" pixels inside a rectangle (text, icon)
  // Content threshold for a frame: the brightness of empty slots plus OCC_MARGIN. Empty slots are the
  // clearly darker cells (by their mean, not by pixels: dark icon pixels inside cargo are darker still).
  // A list with no empty slot in view has no such cells; then the darkest pixels (5th percentile) are used.
  function darkLevel({ w, h, g }, X, Y, cols, rows) {
    const means = [], hist = new Uint32Array(256);
    let total = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = X(c), x1 = X(c + 1), y0 = Y(r), y1 = Y(r + 1), m = Math.round((x1 - x0) * 0.15);
        let s = 0, n = 0;
        for (let yy = Math.max(0, y0 + m); yy < Math.min(h, y1 - m); yy += 2) {
          for (let xx = Math.max(0, x0 + m); xx < Math.min(w, x1 - m); xx += 2) { const v = g[yy * w + xx]; s += v; n++; hist[v]++; }
        }
        if (n) { means.push(s / n); total += n; }
      }
    }
    if (!means.length) return OCC_MAX;
    means.sort((a, b) => a - b);
    let dark = means[Math.floor(means.length * 0.03)];
    if (!(dark < means[means.length >> 1] * 0.6)) {
      let acc = 0, p5 = 0;
      for (; p5 < 255; p5++) { acc += hist[p5]; if (acc >= total * 0.05) break; }
      dark = p5;
    }
    return Math.min(OCC_MAX, Math.max(OCC_MIN, dark + OCC_MARGIN));
  }

  function occupancy({ w, g }, x, y, rw, rh, t = OCC_MAX) {
    const inset = 4; // border only; the item name sits at the top edge
    let n = 0, hit = 0;
    for (let yy = y + inset; yy < y + rh - inset; yy++) {
      for (let xx = x + inset; xx < x + rw - inset; xx++) { n++; if (g[yy * w + xx] > t) hit++; }
    }
    return n ? hit / n : 0;
  }

  // Vertical content shift between two small frames: cur(y) ≈ prev(y + d)
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

  // Mean difference of two equally sized patches
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

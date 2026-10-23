'use strict';
// Звук: розпізнавання звуків «взяв/поклав» за точними сэмплами гри. Без DOM.
//
// Гра (Wwise) на кожну групу предметів програє один і той самий сэмпл, без випадкової зміни висоти.
// Тому звук шукаємо як точний зразок: нормована взаємна кореляція (NCC) форми хвилі з еталоном.
//  * Сигнал ділиться на 5 частотних смуг. Збіг рахується в кожній смузі окремо й складається з вагами
//    «скільки енергії еталона в цій смузі»: голос і гул унизу не заважають впізнати дзвінкий метал
//    угорі, а еквалайзер, що міняє гучність смуг, не ламає порівняння.
//  * Другий, «нижній» бал — лише смуги до 4.5 кГц. Береться кращий із двох: якщо верх зіпсований
//    (стиснення, приглушення в грі), рятує низ.
//  * Порівнюємо лише перші MATCH_SEC еталона й лише коли почався гучний звук: тоді вистачає одного
//    FFT-проходу на звук, а не безперервного сканування.
// Підхід і налаштування (смуги, 24 кГц, 0.2 с еталона, поріг 0.5) — як у програмі «Прослушка».
const Ear = (() => {
  const SAMPLE_RATE = 48000;   // вхід: і живий звук, і бібліотека
  const DECIM = 2;
  const SR = SAMPLE_RATE / DECIM; // смуги після фільтрів — 24 кГц
  const BANDS = [[40, 900], [900, 2500], [2500, 4500], [4500, 8000], [8000, 11500]];
  const LF_MAX_HZ = 4500;
  const MATCH_SEC = 0.2;       // скільки початку еталона порівнюємо
  const PAST_SEC = 0.1;        // вікно пошуку до початку звуку
  const FUTURE_SEC = 0.35;     // і після нього (з еталоном має влізти в одне FFT)
  const MIN_W = 0.03;          // смуга з меншою часткою енергії еталона не враховується
  const BLOCK = 240;           // 10 мс при 24 кГц: крок пошуку початку звуку
  const RETRIGGER_SEC = 0.12;  // новий звук не раніше
  const MIN_LEVEL_DB = -62;    // тихіші звуки не розглядаємо
  const RING_SEC = 3;
  const DEFAULT_THRESHOLD = 0.5;

  // ---- фільтри: Баттерворт 4-го порядку як два біквади (RBJ), окремо ФВЧ і ФНЧ ----
  const BUTTER4_Q = [0.5411961, 1.3065630];
  function biquad(type, f, q, fs) {
    const w = 2 * Math.PI * f / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
    const b = type === 'lp' ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    const a0 = 1 + al;
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 };
  }
  function bandSections([lo, hi]) {
    return [
      ...BUTTER4_Q.map(q => biquad('hp', lo, q, SAMPLE_RATE)),
      ...BUTTER4_Q.map(q => biquad('lp', hi, q, SAMPLE_RATE)),
    ];
  }
  const SECTIONS = BANDS.map(bandSections);

  // Банк фільтрів зі станом (для потоку): 48 кГц моно -> 5 смуг по 24 кГц
  function makeBank() {
    const state = SECTIONS.map(secs => secs.map(() => ({ z1: 0, z2: 0 })));
    let phase = 0;
    return function process(x) {
      const n = Math.floor((x.length + (phase ? 1 : 0)) / DECIM) + 1;
      const out = BANDS.map(() => new Float32Array(n));
      let k = 0;
      for (let i = 0; i < x.length; i++) {
        const keep = phase === 0;
        for (let b = 0; b < BANDS.length; b++) {
          let v = x[i];
          const secs = SECTIONS[b], st = state[b];
          for (let s = 0; s < secs.length; s++) {
            const c = secs[s], z = st[s];
            const y = c.b0 * v + z.z1;
            z.z1 = c.b1 * v - c.a1 * y + z.z2;
            z.z2 = c.b2 * v - c.a2 * y;
            v = y;
          }
          if (keep) out[b][k] = v;
        }
        if (keep) k++;
        phase = (phase + 1) % DECIM;
      }
      return out.map(a => a.subarray(0, k));
    };
  }

  // ---- FFT: комплексний radix-2 з кешем таблиць ----
  const fftTables = new Map();
  function tables(n) {
    let t = fftTables.get(n);
    if (t) return t;
    const levels = Math.log2(n), rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    t = { rev, cos, sin };
    fftTables.set(n, t);
    return t;
  }
  // inverse=false: X[k] = Σ x[n] e^{-2πikn/N}; inverse=true — без ділення на N
  function fft(re, im, inverse) {
    const n = re.length, { rev, cos, sin } = tables(n), sg = inverse ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = sg * sin[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  const MATCH_LEN = Math.round(MATCH_SEC * SR);
  const WIN_LEN = Math.round((PAST_SEC + FUTURE_SEC) * SR);
  let NFFT = 1;
  while (NFFT < WIN_LEN + MATCH_LEN) NFFT <<= 1;

  // ---- еталон ----
  // wave48 — моно 48 кГц. Повертає { L, w, wlf, spec } або null (тиша).
  function makeTemplate(wave48) {
    const pad = new Float32Array(wave48.length + SAMPLE_RATE / 10); // хвіст, щоб фільтри «доспівали»
    pad.set(wave48);
    const bands = makeBank()(pad);
    // початок звуку — де сумарна амплітуда вперше доходить до 5% максимуму
    const len = bands[0].length, full = new Float32Array(len);
    let peak = 0;
    for (let i = 0; i < len; i++) { let s = 0; for (const b of bands) s += b[i]; full[i] = Math.abs(s); if (full[i] > peak) peak = full[i]; }
    if (peak < 1e-5) return null;
    let start = 0;
    while (start < len && full[start] < peak * 0.05) start++;
    start = Math.max(0, start - Math.round(0.005 * SR));
    const L = Math.min(MATCH_LEN, len - start);
    if (L < SR * 0.03) return null;
    const seg = bands.map(b => b.slice(start, start + L));
    const e = seg.map(s => { let v = 0; for (const x of s) v += x * x; return v; });
    const total = e.reduce((a, b) => a + b, 0) || 1;
    let w = e.map(v => v / total);
    w = w.map(v => (v < MIN_W ? 0 : v));
    const ws = w.reduce((a, b) => a + b, 0) || 1;
    w = w.map(v => v / ws);
    const lfIdx = BANDS.map(([, hi], i) => (hi <= LF_MAX_HZ ? i : -1)).filter(i => i >= 0);
    const elf = lfIdx.reduce((a, i) => a + (w[i] ? e[i] : 0), 0);
    const wlf = BANDS.map((_, i) => (lfIdx.includes(i) && w[i] && elf > total * 0.02 ? e[i] / elf : 0));
    // спектри нормованих смуг еталона (спряжені — для кореляції)
    const spec = seg.map((s, b) => {
      if (!w[b] && !wlf[b]) return null;
      const norm = Math.sqrt(e[b]) || 1;
      const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
      for (let i = 0; i < L; i++) re[i] = s[i] / norm;
      fft(re, im, false);
      for (let i = 0; i < NFFT; i++) im[i] = -im[i];
      return { re, im };
    });
    return { L, w, wlf, spec };
  }

  // ---- порівняння вікна з еталонами ----
  // win — 5 смуг по WIN_LEN відліків. tpls — [{ id, kind, tpl }]. Повертає [{ id, kind, score }] за спаданням.
  function match(win, tpls) {
    const N = win[0].length;
    // спектри смуг вікна і ковзна енергія (через накопичені суми)
    const ws = win.map(x => {
      const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
      re.set(x.subarray(0, Math.min(N, NFFT)));
      fft(re, im, false);
      const cs = new Float64Array(N + 1);
      for (let i = 0; i < N; i++) cs[i + 1] = cs[i] + x[i] * x[i];
      return { re, im, cs };
    });
    const out = [];
    const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
    for (const t of tpls) {
      const { L, w, wlf, spec } = t.tpl;
      const npos = N - L + 1;
      if (npos < 1) continue;
      const full = new Float32Array(npos), low = new Float32Array(npos);
      // Кореляції дійсні, тож дві смуги рахуємо одним зворотним FFT: P1 + i·P2 -> corr1 + i·corr2
      const used = spec.map((s, b) => (s ? b : -1)).filter(b => b >= 0);
      for (let u = 0; u < used.length; u += 2) {
        const b1 = used[u], b2 = used[u + 1];
        const X1 = ws[b1], T1 = spec[b1];
        for (let i = 0; i < NFFT; i++) {
          re[i] = X1.re[i] * T1.re[i] - X1.im[i] * T1.im[i];
          im[i] = X1.re[i] * T1.im[i] + X1.im[i] * T1.re[i];
        }
        if (b2 !== undefined) {
          const X2 = ws[b2], T2 = spec[b2];
          for (let i = 0; i < NFFT; i++) {
            const pr = X2.re[i] * T2.re[i] - X2.im[i] * T2.im[i];
            const pi = X2.re[i] * T2.im[i] + X2.im[i] * T2.re[i];
            re[i] -= pi; im[i] += pr; // + i·(pr + i·pi)
          }
        }
        fft(re, im, true);
        for (const [b, part] of [[b1, re], [b2, im]]) {
          if (b === undefined) continue;
          const X = ws[b];
          for (let k = 0; k < npos; k++) {
            const energy = X.cs[k + L] - X.cs[k];
            const ncc = energy > 1e-12 ? part[k] / NFFT / Math.sqrt(energy) : 0;
            full[k] += w[b] * ncc;
            low[k] += wlf[b] * ncc;
          }
        }
      }
      let best = -1;
      for (let k = 0; k < npos; k++) best = Math.max(best, full[k], low[k]);
      out.push({ id: t.id, kind: t.kind, score: best });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // ---- потік: шукає початок звуку і віддає вікно смуг навколо нього ----
  // opts: sens() — поріг над фоном, дБ; muted(); onWindow(win, msAgo) — msAgo: скільки мс тому почався
  //       звук; onRaw(wave48, msAgo) — те саме, але сирий звук 48 кГц (для запису своїх еталонів);
  //       onLevel(db, triggered) — для малювання
  function makeStream(opts) {
    const bank = makeBank();
    const ringLen = Math.round(RING_SEC * SR), rawLen = Math.round(RING_SEC * SAMPLE_RATE);
    const ring = BANDS.map(() => new Float32Array(ringLen)), raw = new Float32Array(rawLen);
    let total = 0, rawTotal = 0;   // скільки відліків уже записано (24 кГц і 48 кГц)
    // Початок звуку шукаємо в кожній смузі окремо: дзвінкий метал видно вгорі, навіть коли низ
    // забитий музикою чи голосом
    const blockE = BANDS.map(() => 0), floor = BANDS.map(() => null);
    let blockN = 0, lastTrig = -Infinity;
    const pending = [];             // відліки (24 кГц), де почався звук і чекаємо хвіст

    function slice(buf, len, end, n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf[((end - n + i) % len + len) % len];
      return out;
    }

    return {
      push(x) {
        for (let i = 0; i < x.length; i++) raw[(rawTotal + i) % rawLen] = x[i];
        rawTotal += x.length;
        const bands = bank(x);
        const n = bands[0].length;
        for (let i = 0; i < n; i++) {
          for (let b = 0; b < BANDS.length; b++) { const v = bands[b][i]; ring[b][total % ringLen] = v; blockE[b] += v * v; }
          blockN++; total++;
          if (blockN < BLOCK) continue;
          const sens = opts.sens(), ready = total - lastTrig > RETRIGGER_SEC * SR && !opts.muted();
          let trig = false, level = -200;
          for (let b = 0; b < BANDS.length; b++) {
            const db = 10 * Math.log10(blockE[b] / blockN + 1e-12);
            blockE[b] = 0;
            level = Math.max(level, db);
            if (floor[b] === null) floor[b] = db;
            if (ready && db > floor[b] + sens && db > MIN_LEVEL_DB) trig = true;
            else floor[b] += (db - floor[b]) * (db < floor[b] ? 0.2 : 0.01); // фон: вниз швидко, вгору повільно
          }
          blockN = 0;
          if (trig) { lastTrig = total; pending.push(total - BLOCK); }
          if (opts.onLevel) opts.onLevel(level, trig);
        }
        // вікно готове, коли після початку звуку минуло FUTURE_SEC
        while (pending.length && total - pending[0] >= FUTURE_SEC * SR) {
          const at = pending.shift();
          const end = at + Math.round(FUTURE_SEC * SR);
          const msAgo = (total - at) / SR * 1000;
          const win = ring.map(r => slice(r, ringLen, end, WIN_LEN));
          opts.onWindow(win, msAgo);
          if (opts.onRaw) {
            const rawEnd = rawTotal - Math.round((total - end) * DECIM);
            opts.onRaw(slice(raw, rawLen, rawEnd + SAMPLE_RATE / 10, Math.round((PAST_SEC + FUTURE_SEC + 0.1) * SAMPLE_RATE)), msAgo);
          }
        }
      },
    };
  }

  // Еталон зі звукового файлу. ctx має працювати на SAMPLE_RATE. Повертає { tpl, dur } або null.
  async function fileTemplate(arrayBuffer, ctx) {
    const audio = await ctx.decodeAudioData(arrayBuffer);
    const mono = new Float32Array(audio.length);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const d = audio.getChannelData(ch);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels;
    }
    const tpl = makeTemplate(mono);
    return tpl && { tpl, dur: audio.duration };
  }

  // Свої записи зберігаємо компактно: 16 біт у base64
  function encodeWave(f32) {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-1, Math.min(1, f32[i])) * 32767;
    let s = '';
    const bytes = new Uint8Array(i16.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function decodeWave(b64) {
    const s = atob(b64), bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    const i16 = new Int16Array(bytes.buffer), f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32767;
    return f32;
  }

  return {
    SAMPLE_RATE, BANDS, DEFAULT_THRESHOLD, WIN_LEN, PAST_SEC,
    makeStream, makeTemplate, fileTemplate, match, encodeWave, decodeWave,
  };
})();

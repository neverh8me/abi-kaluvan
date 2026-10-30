'use strict';
// Sound: recognizing "pick up / put down" sounds by the exact game samples. No DOM.
//
// The game (Wwise) plays the same sample for every item group, with no random pitch change.
// So the sound is matched as an exact sample: normalized cross-correlation (NCC) of the waveform with a template.
//  * The signal is split into 5 frequency bands. The match is computed per band and summed with weights
//    "how much of the template's energy is in this band": voice and rumble down low do not hide a ringing metal
//    sound up high, and an equalizer that changes band volumes does not break the comparison.
//  * A second, "low" score uses only the bands up to 4.5 kHz. The better of the two is taken: if the top is damaged
//    (compression, muffling in the game), the bottom saves it.
//  * Only the first MATCH_SEC of a template is compared, and only when a loud sound starts: then one
//    FFT pass per sound is enough instead of continuous scanning.
// The approach and settings (bands, 24 kHz, 0.2 s template, threshold 0.5) follow the "Proslushka" app.
const Ear = (() => {
  const SAMPLE_RATE = 48000;   // input: both live sound and the library
  const DECIM = 2;
  const SR = SAMPLE_RATE / DECIM; // bands after the filters — 24 kHz
  const BANDS = [[40, 900], [900, 2500], [2500, 4500], [4500, 8000], [8000, 11500]];
  const LF_MAX_HZ = 4500;
  const MATCH_SEC = 0.2;       // how much of the template start is compared
  const PAST_SEC = 0.1;        // search window before the sound start
  const FUTURE_SEC = 0.35;     // and after it (together with the template it must fit into one FFT)
  const MIN_W = 0.03;          // a band with a smaller share of the template energy is ignored
  const BLOCK = 240;           // 10 ms at 24 kHz: step of the sound start search
  const RETRIGGER_SEC = 0.12;  // a new sound not earlier than this
  const MIN_LEVEL_DB = -62;    // quieter sounds are ignored
  const ATTACK_DB = 6;         // a sound start rises at least this much over the previous 20 ms (wind and music swell slower)
  const RING_SEC = 3;
  const DEFAULT_THRESHOLD = 0.5;

  // ---- filters: 4th-order Butterworth as two biquads (RBJ), separate high-pass and low-pass ----
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

  // Filter bank with state (for a stream): 48 kHz mono -> 5 bands at 24 kHz
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

  // ---- FFT: complex radix-2 with cached tables ----
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
  // inverse=false: X[k] = Σ x[n] e^{-2πikn/N}; inverse=true — without dividing by N
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

  // ---- template ----
  // wave48 — mono 48 kHz. Returns { L, w, wlf, spec } or null (silence).
  function makeTemplate(wave48) {
    const pad = new Float32Array(wave48.length + SAMPLE_RATE / 10); // a tail so the filters ring out
    pad.set(wave48);
    const bands = makeBank()(pad);
    // the sound start is where the summed amplitude first reaches 5% of the maximum
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
    // spectra of the normalized template bands (conjugated, for correlation)
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

  // ---- matching a window against templates ----
  // win — 5 bands of WIN_LEN samples. tpls — [{ id, kind, tpl }]. Returns [{ id, kind, score }], best first.
  function match(win, tpls) {
    const N = win[0].length;
    // band spectra of the window and the sliding energy (via cumulative sums)
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
      // The correlations are real, so two bands share one inverse FFT: P1 + i·P2 -> corr1 + i·corr2
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

  // ---- stream: finds a sound start and hands over the band window around it ----
  // opts: sens() — threshold above the background, dB; muted(); onWindow(win, msAgo) — msAgo: how many ms ago
  //       the sound started; onRaw(wave48, msAgo) — the same with raw 48 kHz sound (for recording own templates);
  //       onLevel(db, triggered) — for drawing
  function makeStream(opts) {
    const bank = makeBank();
    const ringLen = Math.round(RING_SEC * SR), rawLen = Math.round(RING_SEC * SAMPLE_RATE);
    const ring = BANDS.map(() => new Float32Array(ringLen)), raw = new Float32Array(rawLen);
    let total = 0, rawTotal = 0;   // how many samples were written so far (24 kHz and 48 kHz)
    // The sound start is searched in every band separately: a ringing metal sound is visible up high even when
    // the bottom is flooded with music or voice
    const blockE = BANDS.map(() => 0), floor = BANDS.map(() => null);
    // the last two block levels of every band: a real pick-up sound starts sharply (attack), wind or music swell slowly
    const prev1 = BANDS.map(() => -200), prev2 = BANDS.map(() => -200);
    const attack = opts.attack === undefined ? ATTACK_DB : opts.attack;
    let blockN = 0, lastTrig = -Infinity;
    const pending = [];             // samples (24 kHz) where a sound started and we wait for its tail

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
            const sharp = db - Math.max(prev1[b], prev2[b]) >= attack;
            prev2[b] = prev1[b]; prev1[b] = db;
            if (ready && db > floor[b] + sens && db > MIN_LEVEL_DB && sharp) trig = true;
            else floor[b] += (db - floor[b]) * (db < floor[b] ? 0.2 : 0.01); // background: falls fast, rises slowly
          }
          blockN = 0;
          if (trig) { lastTrig = total; pending.push(total - BLOCK); }
          if (opts.onLevel) opts.onLevel(level, trig);
        }
        // the window is ready when FUTURE_SEC has passed since the sound start
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

  // A template from a sound file. ctx must run at SAMPLE_RATE. Returns { tpl, dur } or null.
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

  // Own recordings are stored compactly: 16 bit in base64
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

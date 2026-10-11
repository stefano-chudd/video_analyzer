/* dsp.js — self-contained DSP for the spectrogram lab. Zero dependencies.
 * Works in the browser (attaches to window.DSP) and in node (module.exports).
 */
(function () {
  'use strict';

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    return w;
  }

  /* In-place radix-2 FFT. real/imag are Float64Array (or Array), length = power of 2. */
  function fft(real, imag) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = real[i]; real[i] = real[j]; real[j] = t;
        t = imag[i]; imag[i] = imag[j]; imag[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const ur = real[a], ui = imag[a];
          const vr = real[b] * cwr - imag[b] * cwi;
          const vi = real[b] * cwi + imag[b] * cwr;
          real[a] = ur + vr; imag[a] = ui + vi;
          real[b] = ur - vr; imag[b] = ui - vi;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
    }
  }

  /* Average all channels of an AudioBuffer down to mono Float32Array. */
  function downmixToMono(audioBuffer) {
    const ch = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const out = new Float32Array(len);
    if (ch === 1) {
      out.set(audioBuffer.getChannelData(0));
      return out;
    }
    const datas = [];
    for (let c = 0; c < ch; c++) datas.push(audioBuffer.getChannelData(c));
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += datas[c][i];
      out[i] = s / ch;
    }
    return out;
  }

  /**
   * Log-frequency spectrogram.
   * Returns { cols, rows, frames, fps, fmin, fmax, duration } where
   * cols is Float32Array(frames * rows), values normalized to [0, 1],
   * row 0 = lowest frequency. Display is causal by construction: column f
   * depends only on samples <= f * hop (revealing columns up to the playhead
   * never shows the future).
   */
  function computeSpectrogram(mono, sampleRate, opts) {
    opts = opts || {};
    const winSize = 2048;
    let hop = opts.hop || 1024;
    const rows = opts.rows || 240;
    const fmin = opts.fmin || 30;
    const fmax = Math.min(opts.fmax || 16000, sampleRate * 0.49);
    const dbFloor = opts.dbFloor !== undefined ? opts.dbFloor : -90;
    const dbCeil = opts.dbCeil !== undefined ? opts.dbCeil : 30;

    let frames = Math.max(1, Math.floor((mono.length - winSize) / hop) + 1);
    const maxFrames = opts.maxFrames || 12000;
    if (frames > maxFrames) {
      hop = Math.max(1, Math.ceil((mono.length - winSize) / maxFrames));
      frames = Math.max(1, Math.floor((mono.length - winSize) / hop) + 1);
    }
    const fps = sampleRate / hop;

    // Log-spaced band edges, then map each band to FFT bin range.
    const edges = new Float64Array(rows + 1);
    for (let r = 0; r <= rows; r++) {
      edges[r] = fmin * Math.pow(fmax / fmin, r / rows);
    }
    const binHz = sampleRate / winSize;
    const bandStart = new Int32Array(rows);
    const bandEnd = new Int32Array(rows);
    for (let r = 0; r < rows; r++) {
      let s = Math.max(1, Math.floor(edges[r] / binHz));
      let e = Math.max(s + 1, Math.ceil(edges[r + 1] / binHz));
      if (e > winSize / 2) e = winSize / 2;
      bandStart[r] = s; bandEnd[r] = e;
    }

    const win = hann(winSize);
    const real = new Float64Array(winSize);
    const imag = new Float64Array(winSize);
    const cols = new Float32Array(frames * rows);
    const dbRange = dbCeil - dbFloor;

    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let i = 0; i < winSize; i++) {
        real[i] = mono[off + i] * win[i];
        imag[i] = 0;
      }
      fft(real, imag);
      for (let r = 0; r < rows; r++) {
        let m = 0;
        for (let b = bandStart[r]; b < bandEnd[r]; b++) {
          const p = real[b] * real[b] + imag[b] * imag[b];
          if (p > m) m = p;
        }
        const db = 10 * Math.log10(m + 1e-12);
        let v = (db - dbFloor) / dbRange;
        cols[f * rows + r] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    return { cols, rows, frames, fps, hop, fmin, fmax,
             sampleRate, duration: mono.length / sampleRate };
  }

  /* Min/max peaks per bucket for the waveform overview. */
  function computePeaks(mono, buckets) {
    const out = new Float32Array(buckets * 2);
    const per = mono.length / buckets;
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor(b * per), e = Math.max(s + 1, Math.floor((b + 1) * per));
      let mn = 1, mx = -1;
      for (let i = s; i < e && i < mono.length; i++) {
        const v = mono[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      out[b * 2] = mn; out[b * 2 + 1] = mx;
    }
    return out;
  }

  /* Inferno-ish colormap, 256 entries of [r,g,b]. */
  const INFERNO_STOPS = [
    [0.00,   0,   0,   4],
    [0.13,  31,  12,  72],
    [0.25,  59,  15,  79],
    [0.38,  87,  16, 110],
    [0.50, 120,  28, 109],
    [0.63, 165,  44,  96],
    [0.75, 207,  68,  70],
    [0.88, 237, 121,  83],
    [1.00, 252, 255, 164],
  ];

  function buildLUT(stops) {
    const lut = new Uint8Array(256 * 3);
    let s = 0;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
      const a = stops[s], b = stops[s + 1];
      const k = (t - a[0]) / (b[0] - a[0] || 1);
      lut[i * 3]     = Math.round(a[1] + (b[1] - a[1]) * k);
      lut[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * k);
      lut[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * k);
    }
    return lut;
  }

  const LUT = buildLUT(INFERNO_STOPS);

  /**
   * Paint the full spectrogram into an offscreen canvas (frames x rows px).
   * Row 0 (lowest freq) goes to the bottom.
   */
  function renderSpectrogramImage(spec) {
    const { cols, rows, frames } = spec;
    const cv = document.createElement('canvas');
    cv.width = frames; cv.height = rows;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(frames, rows);
    const d = img.data;
    for (let f = 0; f < frames; f++) {
      for (let r = 0; r < rows; r++) {
        const v = cols[f * rows + r];
        const li = (v * 255) | 0;
        const y = rows - 1 - r; // flip: low freq at bottom
        const o = (y * frames + f) * 4;
        d[o] = LUT[li * 3];
        d[o + 1] = LUT[li * 3 + 1];
        d[o + 2] = LUT[li * 3 + 2];
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  const api = {
    hann, fft, downmixToMono, computeSpectrogram, computePeaks,
    renderSpectrogramImage, INFERNO_STOPS, buildLUT, LUT,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.DSP = api;
  }
})();

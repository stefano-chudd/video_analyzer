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

  /* ---------------- pitch & vibrato (v2 experiment) ---------------- */

  /* Box-filter decimation. Good enough anti-aliasing for f0 work. */
  function downsample(mono, fromRate, toRate) {
    const ratio = fromRate / toRate;
    const len = Math.max(1, Math.floor(mono.length / ratio));
    const out = new Float32Array(len);
    const win = Math.max(1, Math.round(ratio));
    for (let i = 0; i < len; i++) {
      const start = Math.floor(i * ratio);
      let s = 0, n = 0;
      for (let k = 0; k < win && start + k < mono.length; k++) {
        s += mono[start + k]; n++;
      }
      out[i] = n ? s / n : 0;
    }
    return out;
  }

  /**
   * YIN pitch tracking (de Cheveigné). Operates on audio downsampled to 8 kHz
   * for speed; returns per-frame f0 in Hz (0 = unvoiced/confidence too low).
   * opts: minF0, maxF0, threshold, frameRange:[a,b) for chunked progress.
   * Returns { f0, conf, fps, sr }.
   */
  function pitchTrack(mono, sampleRate, opts) {
    opts = opts || {};
    const sr = 8000;
    const ds = downsample(mono, sampleRate, sr);
    // 64 ms window: short enough not to smear 5-8 Hz vibrato badly, long
    // enough for 2+ periods at minF0. (A 128 ms window was shown to
    // attenuate 6 Hz vibrato depth ~3.5x via window averaging.)
    const W = 512;                  // 64 ms window
    const hop = 256;                // 32 ms -> 31.25 fps (enough for 5-8 Hz vibrato)
    const minF0 = opts.minF0 || 55;
    const maxF0 = opts.maxF0 || 1200;
    const minTau = Math.max(2, Math.floor(sr / maxF0));
    const maxTau = Math.min(W - 1, Math.ceil(sr / minF0));
    const threshold = opts.threshold || 0.12;
    const accept = 0.25;            // looser bar for the argmin fallback

    const total = Math.max(0, Math.floor((ds.length - W - maxTau) / hop) + 1);
    const range = opts.frameRange || [0, total];
    const a = Math.max(0, range[0]), b = Math.min(total, range[1]);
    const n = Math.max(0, b - a);
    const f0 = new Float32Array(n);
    const conf = new Float32Array(n);
    const d = new Float64Array(maxTau + 1);
    const cm = new Float64Array(maxTau + 1);
    const onProgress = opts.onProgress;

    for (let fi = 0; fi < n; fi++) {
      const f = a + fi;
      const off = f * hop;
      // cheap energy gate first (~ -60 dBFS)
      let e = 0;
      for (let i = 0; i < W; i += 4) { const v = ds[off + i]; e += v * v; }
      if (e / (W / 4) < 1e-6) continue;

      for (let tau = 1; tau <= maxTau; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) {
          const diff = ds[off + j] - ds[off + j + tau];
          s += diff * diff;
        }
        d[tau] = s;
      }
      let rs = 0;
      cm[0] = 1;
      for (let tau = 1; tau <= maxTau; tau++) {
        rs += d[tau];
        cm[tau] = (d[tau] * tau) / rs;
      }
      // first dip below threshold at tau >= minTau, walked to local minimum
      let tauEst = -1;
      for (let tau = minTau; tau <= maxTau; tau++) {
        if (cm[tau] < threshold) {
          while (tau + 1 <= maxTau && cm[tau + 1] < cm[tau]) tau++;
          tauEst = tau;
          break;
        }
      }
      if (tauEst < 0) {
        // fallback: global minimum, accepted only if reasonably periodic
        let m = minTau;
        for (let tau = minTau + 1; tau <= maxTau; tau++) {
          if (cm[tau] < cm[m]) m = tau;
        }
        if (cm[m] < accept) tauEst = m;
      }
      if (tauEst < 0) continue; // unvoiced

      // Octave-up correction: creaky/breathy voice produces period doubling
      // (a strong subharmonic at f0/2), and YIN then locks onto the longer
      // period, reporting one octave low. But a TRUE low tone is not periodic
      // at double its frequency, so check the normalized difference at half
      // the lag: if it is also strongly periodic there, the real pitch is
      // 2*fEst and we take the local minimum near the shorter lag instead.
      // (Measured: period-doubled fry gives cm[tau/2] ~0.35-0.4, a genuine
      // low tone gives ~1.5 — wide margin, threshold sits between.)
      const octThr = opts.octaveThreshold !== undefined ? opts.octaveThreshold : 0.6;
      const tauUp = Math.round(tauEst / 2);
      if (tauUp >= minTau && cm[tauUp] < octThr) {
        let t = tauUp;
        while (t + 1 <= maxTau && cm[t + 1] < cm[t]) t++;
        tauEst = t;
      }

      // parabolic interpolation on the normalized difference
      if (tauEst > minTau && tauEst < maxTau) {
        const y0 = cm[tauEst - 1], y1 = cm[tauEst], y2 = cm[tauEst + 1];
        const denom = y0 - 2 * y1 + y2;
        if (denom !== 0) {
          const shift = 0.5 * (y0 - y2) / denom;
          tauEst += Math.max(-1, Math.min(1, shift));
        }
      }
      const fEst = sr / tauEst;
      if (fEst < minF0 * 0.9 || fEst > maxF0 * 1.1) continue;
      f0[fi] = fEst;
      conf[fi] = Math.max(0, Math.min(1, 1 - cm[Math.round(tauEst)]));
    }

    // NOTE: no smoothing here — callers smooth for display/stats (smoothPitch)
    // but must use the RAW track for vibrato analysis (smoothing erases it).
    if (onProgress) onProgress(1);
    return { f0, conf, fps: sr / hop, sr, frameOffset: a, totalFrames: total };
  }

  /** N-frame median smoothing over voiced runs (for display/stats only). */
  function smoothPitch(f0, width) {
    width = width || 5;
    const half = width >> 1, n = f0.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!f0[i]) continue;
      const vals = [];
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j >= 0 && j < n && f0[j]) vals.push(f0[j]);
      }
      if (vals.length >= 3) {
        vals.sort((x, y) => x - y);
        out[i] = vals[vals.length >> 1];
      } else {
        out[i] = f0[i];
      }
    }
    return out;
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiToName(m) {
    m = Math.round(m);
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }
  function hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }

  /** Semitone histogram of voiced frames, MIDI 36..96 (C2..C7). */
  function pitchHistogram(f0) {
    const bins = new Float32Array(61);
    for (let i = 0; i < f0.length; i++) {
      const v = f0[i];
      if (v <= 0) continue;
      const m = Math.round(hzToMidi(v));
      if (m >= 36 && m <= 96) bins[m - 36]++;
    }
    return bins;
  }

  /**
   * Vibrato analysis on a pitch track. Finds stable voiced segments (>=0.4 s,
   * limited drift), detrends each, and measures modulation rate (zero
   * crossings) and depth (RMS->peak in cents, corrected for the YIN window's
   * averaging via the sinc response at the measured rate). Returns
   * { segments:[{start,end,rateHz,depthCents}], rateMedian, depthMedian }.
   * opts.winSec: YIN window duration in seconds (default 0.064).
   */
  function analyzeVibrato(f0, fps, opts) {
    opts = opts || {};
    const winSec = opts.winSec || 0.064;
    const minLen = Math.floor(0.4 * fps);
    const segs = [];
    let i = 0;
    while (i < f0.length) {
      if (f0[i] <= 0) { i++; continue; }
      let j = i;
      while (j < f0.length && f0[j] > 0) j++;
      if (j - i >= minLen) {
        const sub = f0.subarray(i, j);
        const srt = Array.from(sub).sort((x, y) => x - y);
        const med = srt[srt.length >> 1];
        // reject drifting lines (slides between notes, not vibrato):
        // compare median of first vs last third *in time*
        const n3 = Math.max(1, Math.floor(sub.length / 3));
        const head = Array.from(sub.subarray(0, n3)).sort((x, y) => x - y);
        const tail = Array.from(sub.subarray(sub.length - n3)).sort((x, y) => x - y);
        const medA = head[head.length >> 1], medB = tail[tail.length >> 1];
        const drift = Math.abs(1200 * Math.log2(medB / medA));
        if (drift < 120) {
          const cents = new Float64Array(sub.length);
          for (let k = 0; k < sub.length; k++) {
            cents[k] = 1200 * Math.log2(sub[k] / med);
          }
          let zc = 0;
          for (let k = 1; k < cents.length; k++) {
            if ((cents[k - 1] < 0) !== (cents[k] < 0)) zc++;
          }
          const dur = sub.length / fps;
          const rate = zc / (2 * dur);
          let ss = 0;
          for (let k = 0; k < cents.length; k++) ss += cents[k] * cents[k];
          let depth = Math.sqrt(ss / cents.length) * Math.SQRT2;
          // undo YIN window averaging: |H(f)| = |sinc(pi*f*winSec)|
          const x = Math.PI * rate * winSec;
          const atten = x > 1e-6 ? Math.abs(Math.sin(x) / x) : 1;
          depth /= Math.max(0.33, Math.min(1, atten));
          if (rate >= 3.5 && rate <= 9 && depth >= 8 && depth <= 250) {
            segs.push({ start: i / fps, end: j / fps, rateHz: rate, depthCents: depth });
          }
        }
      }
      i = j;
    }
    const medOf = (arr) => {
      if (!arr.length) return 0;
      const s = arr.slice().sort((x, y) => x - y);
      return s[s.length >> 1];
    };
    return {
      segments: segs,
      rateMedian: medOf(segs.map((s) => s.rateHz)),
      depthMedian: medOf(segs.map((s) => s.depthCents)),
    };
  }

  /** Summary stats for the pitch track. */
  function pitchStats(f0) {
    let voiced = 0, mn = Infinity, mx = -Infinity;
    const vals = [];
    for (let i = 0; i < f0.length; i++) {
      const v = f0[i];
      if (v <= 0) continue;
      voiced++;
      vals.push(v);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    vals.sort((a, b) => a - b);
    return {
      voicedFrames: voiced,
      voicedRatio: f0.length ? voiced / f0.length : 0,
      minHz: voiced ? mn : 0,
      maxHz: voiced ? mx : 0,
      medianHz: voiced ? vals[vals.length >> 1] : 0,
    };
  }

  const api = {
    hann, fft, downmixToMono, computeSpectrogram, computePeaks,
    renderSpectrogramImage, INFERNO_STOPS, buildLUT, LUT,
    downsample, pitchTrack, smoothPitch, pitchHistogram, analyzeVibrato, pitchStats,
    midiToName, hzToMidi, NOTE_NAMES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.DSP = api;
  }
})();

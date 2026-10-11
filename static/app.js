/* app.js — UI wiring, YouTube sync, and the render loop for the spectrogram lab. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    url: $('url'), loadBtn: $('loadBtn'), status: $('status'),
    stage: $('stage'), videoWrap: $('videoWrap'), vtitle: $('vtitle'),
    audioOnlyNote: $('audioOnlyNote'),
    spec: $('spec'), tWinStart: $('tWinStart'), tWinEnd: $('tWinEnd'),
    wavePanel: $('wavePanel'), wave: $('wave'),
    transport: $('transport'), playBtn: $('playBtn'),
    tCur: $('tCur'), tTotal: $('tTotal'), vol: $('vol'), fft: $('fft'),
  };

  // ---------------- state ----------------
  let actx = null;          // one AudioContext: decode + analyser graph
  let audioEl = null;       // master clock for playback
  let analyser = null, fftData = null;
  let spec = null, specImg = null;
  let peaks = null, waveImg = null;
  let duration = 0;
  let ready = false;
  let player = null, ytApiReady = false, currentVid = null;
  let statusToken = 0;
  let lastDrift = 0, lastTimeShown = -1;

  // ---------------- helpers ----------------
  function setStatus(msg, isErr) {
    const t = ++statusToken;
    ui.status.textContent = msg;
    ui.status.classList.toggle('err', !!isErr);
    return t;
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }
  function extractVideoId(url) {
    const m = url.match(
      /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  // ---------------- YouTube ----------------
  function loadYTAPI() {
    if (document.querySelector('script[src*="iframe_api"]')) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }
  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    if (currentVid && !player) createPlayer(currentVid);
  };
  function createPlayer(vid) {
    if (player) { try { player.destroy(); } catch (e) {} player = null; }
    player = new YT.Player('ytplayer', {
      videoId: vid,
      playerVars: { rel: 0, modestbranding: 1 },
      events: {
        onReady: (e) => { e.target.mute(); },
        onStateChange: onYTState,
      },
    });
  }
  function onYTState(e) {
    if (!ready || !audioEl) return;
    const S = YT.PlayerState;
    if (e.data === S.PAUSED && !audioEl.paused) {
      pauseAll();                       // user paused the video -> pause audio
    } else if (e.data === S.PLAYING && audioEl.paused && !audioEl.ended) {
      playAll();                        // user pressed play on the video
    } else if (e.data === S.ENDED) {
      pauseAll();
    }
  }

  // Drift correction: the downloaded audio is the master clock, the muted
  // YouTube player follows it. A *sudden* large jump means the user sought
  // inside the YouTube player — then the audio follows instead.
  setInterval(() => {
    if (!ready || !player || !currentVid || !audioEl || audioEl.paused) return;
    try {
      const st = player.getPlayerState(), S = YT.PlayerState;
      if (st === S.BUFFERING || st === S.CUED) { audioEl.pause(); return; }
      if (st !== S.PLAYING) { player.playVideo(); return; }
      const ytT = player.getCurrentTime(), aT = audioEl.currentTime;
      const d = ytT - aT;
      if (Math.abs(d) > 1.5) {
        if (Math.abs(d - lastDrift) > 2.5) audioEl.currentTime = ytT; // user seek
        else player.seekTo(aT, true);                                // gradual drift
      } else if (Math.abs(d) > 0.35) {
        player.seekTo(aT, true);
      }
      lastDrift = d;
    } catch (e) { /* player not ready yet */ }
  }, 500);

  // ---------------- transport ----------------
  function playAll() {
    if (!ready) return;
    if (actx.state === 'suspended') actx.resume();
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => {});
    if (player && currentVid) { try { player.playVideo(); } catch (e) {} }
    ui.playBtn.textContent = '⏸ Pause';
  }
  function pauseAll() {
    if (audioEl) audioEl.pause();
    if (player) { try { player.pauseVideo(); } catch (e) {} }
    ui.playBtn.textContent = '▶ Play';
  }
  ui.playBtn.addEventListener('click', () => {
    if (!ready || !audioEl) return;
    if (audioEl.paused) playAll(); else pauseAll();
  });
  ui.vol.addEventListener('input', () => {
    if (audioEl) audioEl.volume = parseFloat(ui.vol.value);
  });
  ui.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onLoad();
  });
  ui.loadBtn.addEventListener('click', onLoad);

  function reset() {
    pauseAll();
    ready = false;
    spec = specImg = peaks = waveImg = null;
    duration = 0;
    lastDrift = 0; lastTimeShown = -1;
    for (const c of [ui.spec, ui.wave, ui.fft]) {
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ui.stage.hidden = true;
    ui.wavePanel.hidden = true;
    ui.transport.hidden = true;
  }

  // ---------------- load pipeline ----------------
  async function onLoad() {
    const url = ui.url.value.trim();
    if (!url) { setStatus('Paste a YouTube link first.', true); return; }
    reset();
    const vid = extractVideoId(url);
    let myToken = setStatus('Fetching audio… (downloads once, then cached)');
    ui.loadBtn.disabled = true;

    let info;
    try {
      const r = await fetch('/api/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      info = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(info.error || 'HTTP ' + r.status);
    } catch (e) {
      if (myToken === statusToken) setStatus('Fetch failed: ' + e.message, true);
      ui.loadBtn.disabled = false;
      return;
    }

    if (myToken === statusToken) myToken = setStatus('Decoding + analyzing audio…');
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') await actx.resume();
      const ab = await (await fetch(info.audio_url)).arrayBuffer();
      const buf = await actx.decodeAudioData(ab);
      duration = buf.duration || info.duration || 0;
      const mono = DSP.downmixToMono(buf);
      spec = DSP.computeSpectrogram(mono, buf.sampleRate);
      specImg = DSP.renderSpectrogramImage(spec);
      peaks = DSP.computePeaks(mono, 1400);
      drawWaveform();
    } catch (e) {
      if (myToken === statusToken) setStatus('Analysis failed: ' + e.message, true);
      ui.loadBtn.disabled = false;
      return;
    }

    // Playback element = master clock. Analyser taps it for the live spectrum.
    audioEl = new Audio(info.audio_url);
    audioEl.preload = 'auto';
    audioEl.volume = parseFloat(ui.vol.value);
    const src = actx.createMediaElementSource(audioEl);
    analyser = actx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    src.connect(analyser);
    analyser.connect(actx.destination);
    fftData = new Uint8Array(analyser.frequencyBinCount);
    audioEl.addEventListener('ended', pauseAll);

    ui.vtitle.textContent = '— ' + (info.title || info.id);
    ui.tTotal.textContent = fmtTime(duration);
    ui.stage.hidden = false;
    ui.wavePanel.hidden = false;
    ui.transport.hidden = false;
    ready = true;
    ui.loadBtn.disabled = false;

    currentVid = vid;
    if (vid) {
      ui.audioOnlyNote.hidden = true;
      if (ytApiReady) createPlayer(vid);
      else loadYTAPI(); // onYouTubeIframeAPIReady creates the player
    } else {
      ui.audioOnlyNote.hidden = false;
    }
    if (myToken === statusToken) {
      setStatus(vid ? 'Ready — press play.' :
        'Ready (audio-only: no YouTube video ID in that URL) — press play.');
    }
  }

  // ---------------- rendering ----------------
  function drawWaveform() {
    const c = ui.wave, ctx = c.getContext('2d');
    const W = c.width, H = c.height, mid = H / 2;
    waveImg = document.createElement('canvas');
    waveImg.width = W; waveImg.height = H;
    const g = waveImg.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#2a3350';
    g.beginPath(); g.moveTo(0, mid + 0.5); g.lineTo(W, mid + 0.5); g.stroke();
    const n = peaks.length / 2;
    g.fillStyle = '#5ad1ff';
    for (let b = 0; b < n; b++) {
      const x = (b / n) * W;
      const y1 = mid - peaks[b * 2 + 1] * (mid - 3);
      const y2 = mid - peaks[b * 2] * (mid - 3);
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    ctx.drawImage(waveImg, 0, 0);
  }

  const WIN_SEC = 30; // scrolling spectrogram window

  function drawSpectrogram(t) {
    const c = ui.spec, ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    const winFrames = Math.min(spec.frames,
      Math.max(1, Math.round(Math.min(WIN_SEC, duration) * spec.fps)));
    const x1 = Math.min(spec.frames, Math.max(0, Math.round(t * spec.fps)));
    const x0 = Math.max(0, x1 - winFrames);
    const w = Math.max(1, x1 - x0);
    const dw = (w / winFrames) * W; // fixed time scale; playhead pinned right
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(specImg, x0, 0, w, spec.rows, W - dw, 0, dw, H);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(W - 2, 0, 2, H);
    ui.tWinStart.textContent = fmtTime(x0 / spec.fps);
    ui.tWinEnd.textContent = fmtTime(x1 / spec.fps);
  }

  function drawWavehead(t) {
    const c = ui.wave, ctx = c.getContext('2d');
    ctx.drawImage(waveImg, 0, 0);
    const x = duration > 0 ? (t / duration) * c.width : 0;
    ctx.fillStyle = 'rgba(255,180,84,0.95)';
    ctx.fillRect(x - 1, 0, 2, c.height);
  }

  function drawFFT() {
    const c = ui.fft, ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    analyser.getByteFrequencyData(fftData);
    const N = 96, fmin = 30, fmax = 16000;
    const binHz = actx.sampleRate / analyser.fftSize;
    const bw = W / N;
    for (let i = 0; i < N; i++) {
      const f0 = fmin * Math.pow(fmax / fmin, i / N);
      const f1 = fmin * Math.pow(fmax / fmin, (i + 1) / N);
      const b0 = Math.max(1, Math.floor(f0 / binHz));
      const b1 = Math.min(fftData.length - 1, Math.ceil(f1 / binHz));
      let s = 0, n = 0;
      for (let b = b0; b <= b1; b++) { s += fftData[b]; n++; }
      const v = n ? s / n / 255 : 0;
      const h = Math.max(1, v * H);
      const grad = ctx.createLinearGradient(0, H - h, 0, H);
      grad.addColorStop(0, '#ffb454');
      grad.addColorStop(1, '#7a3c00');
      ctx.fillStyle = grad;
      ctx.fillRect(i * bw + 1, H - h, bw - 2, h);
    }
  }

  function render() {
    requestAnimationFrame(render);
    if (!ready || !spec || !audioEl) return;
    const t = audioEl.currentTime || 0;
    drawSpectrogram(t);
    drawWavehead(t);
    if (analyser) drawFFT();
    const whole = Math.floor(t);
    if (whole !== lastTimeShown) {
      lastTimeShown = whole;
      ui.tCur.textContent = fmtTime(t);
    }
  }

  loadYTAPI();
  requestAnimationFrame(render);
})();

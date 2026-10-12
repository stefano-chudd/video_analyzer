# SpecTube — YouTube audio spectrogram lab (v1 prototype)

Paste a YouTube link. The video plays side-by-side with a **live, causal spectrogram**
(log frequency, inferno colormap), plus a full-track waveform and a live FFT spectrum.
Pause/seek on either the custom transport or the YouTube player's own controls —
the spectrogram stays in sync.

## Why there's a server

The YouTube iframe player is a cross-origin black box: the browser exposes none of
its audio samples. Raw `googlevideo.com` stream URLs don't help either — Google
serves them without CORS headers, so Web Audio reads silence from them. The only
robust path is: download the audio track server-side, serve it same-origin, analyze
it with the Web Audio API. This server does exactly that (yt-dlp under the hood).

The downloaded audio is the **master clock**; the YouTube player stays muted and is
nudged to follow it. A sudden large jump is treated as a user seek inside the
YouTube player, and the audio follows instead.

The spectrogram is precomputed once from the decoded audio (2048-pt Hann FFT,
log-spaced bands, 30 Hz–16 kHz) and **revealed only up to the playhead** — visually
identical to live painting, but pause freezes it exactly and seeks reposition it.
Display is causal: nothing from the future is ever shown.

## Requirements

- Python 3.10+ (`.python-version` pins 3.12 for uv)
- `pip install yt-dlp` (or `uv pip install yt-dlp`, or just `uv run --with yt-dlp server.py`)
- A browser (Chrome recommended)

> Run this on your own machine, not a cloud server: YouTube bot-checks datacenter
> IPs ("sign in to confirm you're not a bot"), which breaks yt-dlp there.

## Run

```bash
cd ytspec
pip install yt-dlp
python server.py            # or: python server.py --port 8000 --host 127.0.0.1
```

Open http://127.0.0.1:8000, paste a link, hit **Load & analyze**, then **Play**.

First load downloads the audio (takes a while for long videos); repeat loads are
served from `downloads/` instantly.

## When YouTube asks for a bot-check sign-in

Sometimes YouTube answers with `Sign in to confirm you're not a bot`, even with
the android player client. Fix: hand yt-dlp your browser cookies —

```bash
python server.py --cookies-from-browser chrome
# or, with an exported Netscape-format cookies file:
python server.py --cookies /path/to/cookies.txt
```

How to export: see
[yt-dlp's FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)
and their
[tips on exporting YouTube cookies](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).
The app also detects this failure and tells you in the status bar.

Treat `cookies.txt` like a password: it grants access to your YouTube account.
It's git-ignored — never commit or share it.

## API

- `POST /api/fetch` `{"url": "..."}` → `{id, title, duration, cached, audio_url}`
- `GET /api/audio/<file>` — audio bytes, CORS-enabled, Range requests supported
- `GET /api/health` → `{ok, yt_dlp, max_duration_sec}`

Non-YouTube URLs work too (anything yt-dlp accepts, e.g. a direct mp3 link) —
the app falls back to audio-only mode when no YouTube video ID is detected.

## v1 scope & limits

- Spectrogram + waveform + live spectrum. No export yet.
- Log frequency scale only; fixed 30 s scrolling window.
- Audio capped at 20 minutes (full decode lives in memory).
- No zoom/scrub on the spectrogram (use the YouTube player's seek bar; sync follows).
- YouTube ads can confuse the drift correction for a few seconds — it recovers.

## v2 experiment: vocal analysis (pitch & vibrato)

After the spectrogram is built, the app runs YIN pitch tracking on the decoded
audio (downsampled to 8 kHz, 64 ms window, 32 ms hop) and shows:

- **Pitch contour** — f0 over the full track on a semitone scale, playhead-synced
- **Tessitura histogram** — where the voice actually lives (semitone bins C2–C7)
- **Stats** — % voiced, range, median, tessitura peak
- **Vibrato** — rate (Hz) and depth (cents) from stable voiced segments,
  with depth corrected for the analysis window's averaging

Caveat: this is experimental. Pitch tracking on full mixes is noisy — the
detector gates on periodicity confidence, but sparse arrangements (solo voice,
THE FIRST TAKE style) give far cleaner results than dense band mixes.

## Files

```
server.py          # local backend: yt-dlp fetch, CORS audio serving, static host
static/index.html  # UI
static/style.css
static/app.js      # player sync, transport, render loop
static/dsp.js      # FFT, log spectrogram, colormap, waveform peaks (node-testable)
downloads/         # cached audio (created on first run)
```

## Test

```bash
node /tmp/dsp_test.js   # DSP correctness on synthetic signals (kept outside the repo)
```

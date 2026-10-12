#!/usr/bin/env python3
"""
ytspec server — local backend for the YouTube live spectrogram lab.

Why a server is needed: the YouTube iframe player is a cross-origin black box
(no access to its audio), and raw googlevideo.com stream URLs are served
without CORS headers, so Web Audio cannot read their samples. This server
downloads the audio track with yt-dlp and serves it same-origin, which the
browser *can* feed into the Web Audio API for analysis.

Run:  python server.py [--port 8000]
Then open http://localhost:8000 in a browser.

Requires: pip install yt-dlp
"""

import argparse
import glob
import http.server
import json
import mimetypes
import os
import re
import shutil
import socketserver
import subprocess
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
DOWNLOAD_DIR = os.path.join(ROOT, "downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

YTDLP_BASE = None    # [python, -m, yt_dlp] + cookie args (no player client)
CLIENT_CASCADE = None  # e.g. ["android", "ios", "web"]; tried in order
# v1 guardrail: decoding the full audio into memory gets heavy past this.
MAX_DURATION_SEC = 20 * 60

# Failures worth trying the next player client for.
RETRYABLE_ERRORS = ("Requested format is not available", "needs to be reloaded")
# Failures where other clients won't help (fail fast instead).
AUTH_ERRORS = ("not a bot", "Sign in to confirm")


def client_argv(client):
    """--extractor-args for a player client; [] = yt-dlp's own default."""
    if not client or client.strip().lower() in ("default", "none"):
        return []
    return ["--extractor-args", f"youtube:player_client={client.strip()}"]


def ejs_remote_args():
    """If the EJS challenge-solver package isn't installed alongside yt-dlp
    (PyPI installs don't bundle it), have yt-dlp fetch it from GitHub."""
    try:
        import importlib.util
        if importlib.util.find_spec("yt_dlp_ejs") is not None:
            return []
    except Exception:
        pass
    sys.stderr.write(
        "ytspec: yt-dlp-ejs solver not installed; enabling "
        "--remote-components ejs:github\n")
    return ["--remote-components", "ejs:github"]


def build_server_config(cli):
    """Returns (base_argv, client_cascade)."""
    base = [sys.executable, "-m", "yt_dlp"] + ejs_remote_args()
    if cli.cookies_from_browser:
        base += ["--cookies-from-browser", cli.cookies_from_browser]
    if cli.cookies:
        if not os.path.isfile(cli.cookies):
            sys.stderr.write(f"ERROR: cookies file not found: {cli.cookies}\n")
            sys.exit(1)
        base += ["--cookies", cli.cookies]
    if cli.js_runtimes:
        base += ["--js-runtimes", cli.js_runtimes]
    pc = (cli.player_client or "android").strip().lower()
    cascade = []
    if pc == "default":
        cascade.append("default")  # yt-dlp's own internal client battery first
    elif pc not in ("none", ""):
        cascade.append(pc)
    for c in ("android", "ios", "web"):
        if c not in cascade:
            cascade.append(c)
    return base, cascade


def botcheck_hint(stderr_text):
    """If yt-dlp failed on YouTube's bot-check, explain the cookie fix."""
    s = stderr_text or ""
    if ("not a bot" in s) or ("Sign in to confirm" in s):
        return ("YouTube asked for a bot-check sign-in. Restart the server with "
                "cookies, e.g.  --cookies-from-browser chrome  or  "
                "--cookies /path/to/cookies.txt  (see README).")
    return None


def challenge_hint(stderr_text):
    """If YouTube's signature/n challenges couldn't be solved, point at the
    missing JavaScript runtime (this surfaces as 'The page needs to be
    reloaded' / 'Requested format is not available')."""
    s = stderr_text or ""
    if "challenge solving failed" in s or "Signature solving failed" in s:
        return ("yt-dlp could not solve YouTube's signature/n challenges: "
                "install a JavaScript runtime (Deno or Node.js) and restart "
                "the server. See https://github.com/yt-dlp/yt-dlp/wiki/EJS")
    return None


def failure_hints(stderr_text):
    """Combine all applicable failure hints into a prefix string."""
    hints = [h for h in (botcheck_hint(stderr_text), challenge_hint(stderr_text)) if h]
    return (" ".join(hints) + " ") if hints else ""


def check_js_runtime():
    """Best-effort PATH check for a JS runtime yt-dlp can use."""
    import shutil
    for rt in ("deno", "node", "bun", "qjs"):
        if shutil.which(rt):
            return rt
    return None


def check_ytdlp():
    try:
        out = subprocess.run(
            YTDLP_BASE + ["--version"], capture_output=True, text=True, timeout=30
        )
        return out.stdout.strip()
    except Exception:
        return None


def run_ytdlp(args, timeout=900):
    return subprocess.run(
        YTDLP_BASE + args, capture_output=True, text=True, timeout=timeout
    )


def run_ytdlp_cascade(args, timeout=900):
    """Try each player client in CLIENT_CASCADE until one succeeds.

    Returns (result, working_client, tried). Stops early on auth errors
    (other clients won't help) and on errors unrelated to the client."""
    tried = []
    last = None
    for client in CLIENT_CASCADE:
        tried.append(client)
        r = subprocess.run(
            YTDLP_BASE + client_argv(client) + args,
            capture_output=True, text=True, timeout=timeout
        )
        if r.returncode == 0:
            return r, client, tried
        last = r
        err = r.stderr or ""
        if any(k in err for k in AUTH_ERRORS):
            break  # needs cookies; other clients won't help
        if not any(k in err for k in RETRYABLE_ERRORS):
            break  # not a client problem; don't waste attempts
        sys.stderr.write(f"ytspec: player client '{client}' failed; trying next\n")
    return last, None, tried


def run_ytdlp_single(client, args, timeout=900):
    """Run once with an explicitly chosen player client."""
    return subprocess.run(
        YTDLP_BASE + client_argv(client) + args,
        capture_output=True, text=True, timeout=timeout
    )


def video_meta(url):
    """Resolve id/title/duration without downloading (also validates the URL).

    Note: --print is always paired with --skip-download here: in this yt-dlp
    build, --print on its own skips the actual download, so metadata and
    downloading are deliberately two separate steps.

    Returns (vid, title, duration, working_client)."""
    r, client, tried = run_ytdlp_cascade(
        ["--no-warnings", "--skip-download",
         "--print", "%(id)s\t%(title)s\t%(duration)s", url],
        timeout=120)
    lines = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
    if r.returncode != 0 or not lines:
        err = (r.stderr or "").strip().splitlines()
        raise RuntimeError(
            failure_hints(r.stderr) +
            f"Could not resolve that URL (tried clients: {', '.join(tried)}): " +
            (err[-1] if err else "yt-dlp failed"))
    tail = lines[-1]
    head, _, dur_s = tail.rpartition("\t")  # title itself may contain tabs
    vid, _, title = head.partition("\t")
    vid = vid.strip()
    if not vid or not re.fullmatch(r"[\w-]{3,64}", vid):
        raise RuntimeError("Could not resolve that URL: bad video id")
    try:
        duration = float(dur_s.strip())
    except ValueError:
        duration = 0
    return vid, title.strip() or vid, duration, client


def existing_audio(vid):
    hits = sorted(glob.glob(os.path.join(DOWNLOAD_DIR, vid + ".*")))
    return hits[0] if hits else None


def fetch_audio(url):
    """Download best audio for url (or reuse cache). Returns info dict."""
    vid, title, duration, client = video_meta(url)

    if duration and duration > MAX_DURATION_SEC:
        raise RuntimeError(
            f"Audio is {duration/60:.0f} min — v1 supports up to "
            f"{MAX_DURATION_SEC//60} min.")

    path = existing_audio(vid)
    cached = path is not None

    if not cached:
        tmpl = os.path.join(DOWNLOAD_DIR, "%(id)s.%(ext)s")
        # reuse the player client that worked for metadata
        r = run_ytdlp_single(client, [
            "--no-warnings", "--no-playlist",
            "-f", "bestaudio/best",
            "-o", tmpl,
            url,
        ])
        if r.returncode != 0:
            err = (r.stderr or "").strip().splitlines()
            raise RuntimeError(failure_hints(r.stderr) +
                               "Download failed: " +
                               (err[-1] if err else "yt-dlp error"))
        path = existing_audio(vid)
        if not path:
            raise RuntimeError("Download finished but no audio file found.")

    return {
        "id": vid,
        "title": title,
        "duration": duration,
        "cached": cached,
        "audio_url": "/api/audio/" + os.path.basename(path),
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "ytspec/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    # ---- helpers -----------------------------------------------------
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_audio(self, name):
        name = os.path.basename(urllib.parse.unquote(name))
        if not name or name.startswith("."):
            return self._json(400, {"error": "bad filename"})
        path = os.path.join(DOWNLOAD_DIR, name)
        if not os.path.isfile(path):
            return self._json(404, {"error": "not found"})

        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end, status = 0, size - 1, 200
        rh = self.headers.get("Range")
        if rh:
            m = re.match(r"bytes=(\d*)-(\d*)\s*$", rh)
            if m:
                s, e = m.groups()
                if s == "" and e != "":
                    start = max(0, size - int(e))
                elif s != "":
                    start = int(s)
                    end = int(e) if e != "" else size - 1
                start = max(0, min(start, size - 1))
                end = max(start, min(end, size - 1))
                status = 206

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range",
                             f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # ---- routes ------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.end_headers()

    def do_HEAD(self):
        if self.path.startswith("/api/audio/"):
            return self._serve_audio(self.path[len("/api/audio/"):])
        return super().do_HEAD()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            return self._json(200, {"ok": True,
                                    "yt_dlp": check_ytdlp(),
                                    "max_duration_sec": MAX_DURATION_SEC})
        if parsed.path.startswith("/api/audio/"):
            return self._serve_audio(parsed.path[len("/api/audio/"):])
        if parsed.path.startswith("/api/"):
            return self._json(404, {"error": "unknown endpoint"})
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/fetch":
            return self._json(404, {"error": "unknown endpoint"})
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid JSON"})
        url = (body.get("url") or "").strip()
        if not url:
            return self._json(400, {"error": "missing 'url'"})
        try:
            info = fetch_audio(url)
        except RuntimeError as e:
            return self._json(422, {"error": str(e)})
        except subprocess.TimeoutExpired:
            return self._json(504, {"error": "download timed out"})
        except Exception as e:  # never leak a traceback to the client
            return self._json(500, {"error": f"unexpected error: {e}"})
        return self._json(200, info)

    def log_message(self, fmt, *args):
        sys.stderr.write("ytspec: " + fmt % args + "\n")


def main():
    ap = argparse.ArgumentParser(description="ytspec local server")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--cookies-from-browser", metavar="BROWSER", default=None,
                    help="e.g. chrome — hand that browser's YouTube cookies to "
                         "yt-dlp (workaround for 'Sign in to confirm you're not "
                         "a bot' errors)")
    ap.add_argument("--cookies", metavar="FILE", default=None,
                    help="Netscape-format cookies.txt for yt-dlp (same workaround)")
    ap.add_argument("--player-client", metavar="CLIENT", default="android",
                    help="Preferred YouTube player client for yt-dlp "
                         "(default: android, avoids datacenter bot-checks). "
                         "The server falls back through android/ios/web on "
                         "client-related failures; use 'default' to let "
                         "yt-dlp choose first.")
    ap.add_argument("--js-runtimes", metavar="RUNTIMES", default=None,
                    help="pass through to yt-dlp --js-runtimes "
                         "(e.g. 'deno' or 'node:/path/to/node') for YouTube's "
                         "signature/n challenges")
    args = ap.parse_args()

    global YTDLP_BASE, CLIENT_CASCADE
    YTDLP_BASE, CLIENT_CASCADE = build_server_config(args)

    if not check_js_runtime() and not args.js_runtimes:
        sys.stderr.write(
            "WARNING: no JavaScript runtime (deno/node/bun/qjs) found on PATH; "
            "yt-dlp cannot solve YouTube's signature/n challenges and some "
            "videos will fail with 'The page needs to be reloaded'. "
            "See https://github.com/yt-dlp/yt-dlp/wiki/EJS\n")

    ver = check_ytdlp()
    if not ver:
        sys.stderr.write(
            "ERROR: yt-dlp not found. Install it first:\n"
            "    pip install yt-dlp\n")
        sys.exit(1)

    for f in ("index.html", "app.js", "dsp.js", "style.css"):
        if not os.path.isfile(os.path.join(STATIC_DIR, f)):
            sys.stderr.write(f"WARNING: static/{f} missing\n")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(
            (args.host, args.port), Handler) as httpd:
        print(f"ytspec up  →  http://{args.host}:{args.port}/   "
              f"(yt-dlp {ver})")
        print("Downloads are cached in ./downloads/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")


if __name__ == "__main__":
    main()

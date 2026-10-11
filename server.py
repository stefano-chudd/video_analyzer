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

YTDLP = [sys.executable, "-m", "yt_dlp",
         # "android" player client avoids YouTube's datacenter bot-checks;
         # ignored for non-YouTube URLs.
         "--extractor-args", "youtube:player_client=android"]
# v1 guardrail: decoding the full audio into memory gets heavy past this.
MAX_DURATION_SEC = 20 * 60


def check_ytdlp():
    try:
        out = subprocess.run(
            YTDLP + ["--version"], capture_output=True, text=True, timeout=30
        )
        return out.stdout.strip()
    except Exception:
        return None


def run_ytdlp(args, timeout=900):
    return subprocess.run(
        YTDLP + args, capture_output=True, text=True, timeout=timeout
    )


def video_meta(url):
    """Resolve id/title/duration without downloading (also validates the URL).

    Note: --print is always paired with --skip-download here: in this yt-dlp
    build, --print on its own skips the actual download, so metadata and
    downloading are deliberately two separate steps.
    """
    r = run_ytdlp(["--no-warnings", "--skip-download",
                   "--print", "%(id)s\t%(title)s\t%(duration)s", url],
                  timeout=120)
    lines = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
    if r.returncode != 0 or not lines:
        err = (r.stderr or "").strip().splitlines()
        raise RuntimeError("Could not resolve that URL: " +
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
    return vid, title.strip() or vid, duration


def existing_audio(vid):
    hits = sorted(glob.glob(os.path.join(DOWNLOAD_DIR, vid + ".*")))
    return hits[0] if hits else None


def fetch_audio(url):
    """Download best audio for url (or reuse cache). Returns info dict."""
    vid, title, duration = video_meta(url)

    if duration and duration > MAX_DURATION_SEC:
        raise RuntimeError(
            f"Audio is {duration/60:.0f} min — v1 supports up to "
            f"{MAX_DURATION_SEC//60} min.")

    path = existing_audio(vid)
    cached = path is not None

    if not cached:
        tmpl = os.path.join(DOWNLOAD_DIR, "%(id)s.%(ext)s")
        r = run_ytdlp([
            "--no-warnings", "--no-playlist",
            "-f", "bestaudio/best",
            "-o", tmpl,
            url,
        ])
        if r.returncode != 0:
            err = (r.stderr or "").strip().splitlines()
            raise RuntimeError("Download failed: " +
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
    args = ap.parse_args()

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

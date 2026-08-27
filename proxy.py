#!/usr/bin/env python3
"""Optional zero-dependency helper for Bravia Console (Python flavor).

Many Bravia displays never answer CORS preflights, and a browser then
blocks every direct request the app makes to the TV. This script serves
the app's static files AND forwards /sony/* requests to the TV, so
everything becomes same-origin and works in any unmodified browser.

Usage:   python proxy.py <tv-host[:port]> [port] [bind-address]
Example: python proxy.py 192.168.1.50
         -> open http://localhost:8585

Defaults: port 8585, bound to 127.0.0.1 (this machine only).
Bind to 0.0.0.0 to reach the app from other devices on your LAN, but
note anyone who can reach the port can then control the TV.
"""

import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if len(sys.argv) < 2:
    print("Usage: python proxy.py <tv-host-or-ip[:port]> [port] [bind-address]")
    sys.exit(1)

TV = sys.argv[1] if ":" in sys.argv[1] else sys.argv[1] + ":80"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8585
BIND = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"
ROOT = Path(__file__).resolve().parent

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter log
        print("%s %s" % (self.command, self.path))

    def _send(self, status, ctype, body: bytes):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/__proxy":
            self._send(200, "application/json",
                       json.dumps({"proxy": True, "tv": TV}).encode())
            return
        rel = "index.html" if path == "/" else path.lstrip("/")
        file = (ROOT / rel).resolve()
        if ".." in rel or ROOT not in file.parents:
            self._send(403, "text/plain", b"Forbidden")
            return
        try:
            data = file.read_bytes()
        except OSError:
            self._send(404, "text/plain", b"Not found")
            return
        self._send(200, MIME.get(file.suffix, "application/octet-stream"), data)

    def do_POST(self):
        path = self.path.split("?")[0]
        if not path.startswith("/sony/"):
            self._send(404, "text/plain", b"Not found")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        headers = {
            "Content-Type": self.headers.get("Content-Type", "application/json"),
            "X-Auth-PSK": self.headers.get("X-Auth-PSK", ""),
        }
        if self.headers.get("SOAPAction"):
            headers["SOAPAction"] = self.headers["SOAPAction"]
        req = urllib.request.Request(f"http://{TV}{path}", data=body,
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                self._send(resp.status,
                           resp.headers.get("Content-Type", "application/json"),
                           resp.read())
        except urllib.error.HTTPError as e:
            self._send(e.code, e.headers.get("Content-Type", "application/json"),
                       e.read())
        except OSError as e:
            self._send(502, "application/json",
                       json.dumps({"error": [502, f"Proxy could not reach TV at {TV}: {e}"]}).encode())


if __name__ == "__main__":
    print("Bravia Console proxy")
    print(f"  forwarding /sony/* -> http://{TV}/sony/*")
    host = "localhost" if BIND in ("0.0.0.0", "127.0.0.1") else BIND
    print(f"  open http://{host}:{PORT}")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()

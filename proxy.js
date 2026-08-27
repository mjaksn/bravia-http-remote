#!/usr/bin/env node
'use strict';

/*
 * Optional zero-dependency helper for Bravia Console.
 *
 * Browsers block direct cross-origin requests to the TV because Bravia
 * displays never answer CORS preflights. This script serves the app's
 * static files AND forwards /sony/* requests to the TV, so everything
 * becomes same-origin and works in any unmodified browser.
 *
 * Usage:   node proxy.js <tv-host> [port] [bind-address]
 * Example: node proxy.js 192.168.1.50
 *          → open http://localhost:8585
 *
 * Defaults: port 8585, bound to 127.0.0.1 (this machine only).
 * Bind to 0.0.0.0 to reach the app from other devices on your LAN, but
 * note anyone who can reach the port can then control the TV.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const tvArg = process.argv[2] || '';
const port = parseInt(process.argv[3], 10) || 8585;
const bind = process.argv[4] || '127.0.0.1';

if (!tvArg) {
  console.error('Usage: node proxy.js <tv-host-or-ip[:port]> [port] [bind-address]');
  process.exit(1);
}
const [tvHost, tvPortStr] = tvArg.split(':');
const tvPort = parseInt(tvPortStr, 10) || 80;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const root = __dirname;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/__proxy') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ proxy: true, tv: tvHost }));
    return;
  }

  if (url.startsWith('/sony/')) {
    // Buffer the body so the forwarded request carries Content-Length:
    // embedded Bravia HTTP stacks may reject chunked request bodies.
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const fwd = http.request(
        {
          host: tvHost,
          port: tvPort,
          path: url,
          method: req.method,
          headers: {
            'Content-Type': req.headers['content-type'] || 'application/json',
            'Content-Length': body.length,
            'X-Auth-PSK': req.headers['x-auth-psk'] || '',
            ...(req.headers.soapaction ? { SOAPAction: req.headers.soapaction } : {}),
          },
          timeout: 10000,
        },
        (tvRes) => {
          res.writeHead(tvRes.statusCode, { 'Content-Type': tvRes.headers['content-type'] || 'application/json' });
          tvRes.pipe(res);
          tvRes.on('error', () => res.destroy());
        }
      );
      fwd.on('timeout', () => fwd.destroy(new Error('timeout')));
      fwd.on('error', (e) => {
        // Headers may already be streaming from the TV; writeHead would throw.
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: [502, 'Proxy could not reach TV at ' + tvHost + ': ' + e.message] }));
      });
      fwd.end(body);
    });
    return;
  }

  // Static files, no directory traversal.
  const rel = url === '/' ? 'index.html' : url.slice(1);
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root) || rel.includes('..')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, bind, () => {
  console.log(`Bravia Console proxy`);
  console.log(`  forwarding /sony/* → http://${tvHost}:${tvPort}/sony/*`);
  console.log(`  open http://${bind === '0.0.0.0' ? 'localhost' : bind}:${port}`);
});

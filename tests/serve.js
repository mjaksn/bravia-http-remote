'use strict';

/* Static server for the browser suites.
 *
 * Serves the app from whichever directory is under test (the repo, or an
 * unpacked release artefact), the harness pages from tests/browser, and
 * three things the suites need that a plain file server cannot give them:
 * a deploy-config.js chosen per suite, a /sony/* endpoint that answers
 * 403 so a rejected key can be exercised, and a /result sink the harness
 * posts its findings to.
 *
 * Harness pages have to share an origin with the app to reach into the
 * iframe, which is why they are served from here rather than opened off
 * disk. No dependencies, same as everything else.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const HARNESS_DIR = path.join(__dirname, 'browser');

/* Resolves to {server, port}. Port 0 asks the OS for a free one, so
   suites never collide with each other or with a stray dev server. */
function start({ root, deployConfig = null, onResult, port = 0 } = {}) {
  const appRoot = path.resolve(root || path.join(__dirname, '..'));

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'POST' && url === '/result') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        if (onResult) onResult(body);
      });
      return;
    }

    // A rejected pre-shared key, for the suite that checks what the app
    // does about one.
    if (url.startsWith('/sony/')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: [403, 'Forbidden'] }));
      return;
    }

    // The suite picks the deployment config, so the copy in the working
    // tree is never touched and never has to be put back.
    if (url === '/deploy-config.js' && deployConfig !== null) {
      res.writeHead(200, { 'Content-Type': TYPES['.js'] });
      res.end(deployConfig);
      return;
    }

    const send = (file, dir) => {
      const full = path.resolve(path.join(dir, file));
      if (!full.startsWith(dir)) { res.writeHead(403); res.end('Forbidden'); return; }
      fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
        res.end(data);
      });
    };

    if (url.startsWith('/harness/')) { send(url.slice('/harness/'.length), HARNESS_DIR); return; }
    send(url === '/' ? 'index.html' : decodeURIComponent(url.slice(1)), appRoot);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

module.exports = { start };

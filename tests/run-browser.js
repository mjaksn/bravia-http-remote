'use strict';

/* Runs the browser suites against a real headless browser.
 *
 *   node tests/run-browser.js                 the working tree
 *   node tests/run-browser.js --root DIR      an unpacked release artefact
 *
 * Set CHROME_PATH to choose a browser; otherwise the usual install
 * locations are tried. Chromium is what this drives, and any of Chrome,
 * Chromium or Edge will do.
 *
 * Each suite gets its own server and its own deployment config, so the
 * copy of deploy-config.js in the working tree is never touched.
 */

const nodeCrypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
}
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const Lockbox = require('../lockbox.js');
const { start } = require('./serve.js');

const SUITE_TIMEOUT_MS = 180000;

/* The suites care about the lock's behaviour, not about how long a key
   derivation takes, and each one unlocks several times. Sealing the test
   fixtures with a low iteration count keeps the run quick; the cost of the
   shipped default is covered in tests/lockbox.test.js instead. */
const TEST_ITERATIONS = 2000;

function sealed(secret) {
  return '/* generated for a test run */\nwindow.BRAVIA_DEPLOY_CONFIG = ' +
    JSON.stringify(Lockbox.seal('letmein', secret, TEST_ITERATIONS), null, 2) + ';\n';
}

const SUITES = [
  {
    name: 'sealed',
    page: 'sealed.html',
    // Port 1 answers nothing, so the connection attempt fails at once
    // instead of holding the suite up for the request timeout.
    deployConfig: sealed({
      host: '127.0.0.1:1', psk: 'super-secret-psk', interval: 7,
      // Two real cards and one name that is not a card: the suite checks
      // both that the two go and that the third is passed over rather
      // than throwing the unlock away.
      hiddenCards: ['apps', 'sound', 'not-a-card'],
    }),
  },
  {
    name: 'unsealed',
    page: 'unsealed.html',
    deployConfig: null,      // the placeholder the repo ships
  },
  {
    name: 'authfail',
    page: 'authfail.html',
    deployConfig: sealed({ host: '', psk: 'same-origin-key', interval: 5 }),
  },
];

function findBrowser() {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

function runSuite(browser, suite, root) {
  return new Promise(async (resolve) => {
    let settled = false;
    let child = null;
    let server = null;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bravia-suite-'));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) { try { child.kill(); } catch { /* already gone */ } }
      if (server) server.close();
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, text: 'timed out after ' + SUITE_TIMEOUT_MS + ' ms' }),
      SUITE_TIMEOUT_MS);

    const started = await start({
      root,
      deployConfig: suite.deployConfig,
      onResult: (body) => finish({ ok: body.startsWith('PASSED'), text: body }),
    });
    server = started.server;

    const url = `http://127.0.0.1:${started.port}/harness/${suite.page}`;
    child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // Chromium's sandbox needs kernel facilities a build agent may not
      // hand it. Dropped on a runner only, never on a real desktop.
      ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      '--user-data-dir=' + profile,
      url,
    ], { stdio: 'ignore' });

    child.on('error', (e) => finish({ ok: false, text: 'could not start the browser: ' + e.message }));
  });
}

async function main() {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag === -1 ? path.join(__dirname, '..') : path.resolve(process.argv[rootFlag + 1]);

  const browser = findBrowser();
  if (!browser) {
    console.error('No Chrome, Chromium or Edge found. Set CHROME_PATH to one.');
    process.exit(1);
  }
  console.log('browser: ' + browser);
  console.log('app root: ' + root + '\n');

  let failed = 0;
  for (const suite of SUITES) {
    const result = await runSuite(browser, suite, root);
    const lines = result.text.split('\n');
    console.log(`── ${suite.name} ${'─'.repeat(Math.max(1, 40 - suite.name.length))}`);
    // A passing suite prints its assertions; a failing one is worth
    // reading in full, so print everything either way.
    console.log(lines.join('\n') + '\n');
    if (!result.ok) failed++;
  }

  console.log(failed ? `${failed} of ${SUITES.length} suites FAILED` : `all ${SUITES.length} suites passed`);
  process.exit(failed ? 1 : 0);
}

main();

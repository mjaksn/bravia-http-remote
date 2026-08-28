'use strict';

/* seal.py and lockbox.js must agree, byte for byte.
 *
 * There are now two implementations of one format: lockbox.js, which the
 * browser runs, and seal.py, which the installer runs on a machine with no
 * display. A disagreement between them is the worst kind of bug this
 * project can have, because it is silent: seal.py checks its own work by
 * opening what it just wrote, and that check passes just as happily when
 * both halves are wrong together.
 *
 * So neither is allowed to mark its own homework here. Each seals, the
 * other opens, in both directions.
 *
 * Run: node tests/seal.test.js
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
}
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const L = require('../lockbox.js');
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function eq(name, got, want) {
  if (got === want) { passed++; console.log('ok   ' + name); return; }
  failed++;
  console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want);
}

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('ok   ' + name); return; }
  failed++;
  console.log('FAIL ' + name + (detail ? '\n  ' + detail : ''));
}

/* Which interpreter. proxy.py already makes Python part of this project,
   so a missing one is a broken environment rather than a reason to skip:
   a skipped test looks exactly like a passing one in a CI log.
 *
 * Resolved to an absolute path through a shell, once, and then used
 * directly. On Windows the name on PATH is often a .bat shim, which
 * CreateProcess will not launch, so a bare execFileSync('python') fails
 * with ENOENT on a machine that has Python perfectly well installed.
 */
function python() {
  for (const candidate of ['python3', 'python']) {
    try {
      // One quoted command string rather than shell:true with separate
      // args, which concatenates them unquoted and lets the semicolon
      // below split the command in two.
      const found = execSync(candidate + ' -c "import sys; print(sys.executable)"',
                             { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (found && fs.existsSync(found)) return found;
    } catch { /* try the next one */ }
  }
  throw new Error(
    'no python3 on PATH. seal.py is part of this project and these tests drive it.');
}

const PY = python();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bravia-seal-'));
const pwFile = path.join(work, 'password');
const PASSWORD = 'a password with spaces and a é';
const SECRET = { host: '192.168.1.50:80', psk: 'p$k-0000', interval: 7 };

fs.writeFileSync(pwFile, PASSWORD, 'utf8');

try {

  /* ── python seals, the browser's code opens ─────────────────────────── */

  const out = path.join(work, 'deploy-config.js');
  execFileSync(PY, [path.join(ROOT, 'seal.py'),
                    '--host', SECRET.host,
                    '--psk', SECRET.psk,
                    '--interval', String(SECRET.interval),
                    '--out', out,
                    '--password-file', pwFile], { stdio: 'pipe' });

  // Evaluated the way the browser loads it: a script that assigns to
  // window. Anything else would be testing a file this app never reads.
  const win = {};
  new Function('window', fs.readFileSync(out, 'utf8'))(win);
  const blob = win.BRAVIA_DEPLOY_CONFIG;

  ok('seal.py writes a file that assigns the deploy config', !!blob);
  eq('and declares the format lockbox.js expects', blob.kdf, 'pbkdf2-hmac-sha256');
  eq('and the version', blob.v, 1);
  eq('and the documented stretching', blob.iterations, L.DEFAULT_ITERATIONS);

  const opened = L.open(PASSWORD, blob);
  eq('lockbox.js opens it: host', opened.host, SECRET.host);
  eq('lockbox.js opens it: psk', opened.psk, SECRET.psk);
  eq('lockbox.js opens it: interval', opened.interval, SECRET.interval);

  let denied = false;
  try { L.open(PASSWORD + 'x', blob); } catch (e) { denied = e.message === 'Access denied'; }
  ok('a wrong password is denied, not decoded', denied);

  /* ── the browser's code seals, python opens ─────────────────────────── */

  const jsBlob = L.seal(PASSWORD, SECRET);
  const jsFile = path.join(work, 'js-sealed.json');
  fs.writeFileSync(jsFile, JSON.stringify(jsBlob), 'utf8');

  const reader = path.join(work, 'read.py');
  fs.writeFileSync(reader, [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from seal import open_sealed',
    'blob = json.load(open(sys.argv[2], encoding="utf-8"))',
    'password = open(sys.argv[3], encoding="utf-8").read()',
    'print(json.dumps(open_sealed(password, blob)))',
    '',
  ].join('\n'), 'utf8');

  const back = JSON.parse(
    execFileSync(PY, [reader, ROOT, jsFile, pwFile], { encoding: 'utf8' }));
  eq('seal.py opens what lockbox.js sealed: host', back.host, SECRET.host);
  eq('seal.py opens what lockbox.js sealed: psk', back.psk, SECRET.psk);
  eq('seal.py opens what lockbox.js sealed: interval', back.interval, SECRET.interval);

  /* ── the ceiling, which only the other implementation enforces ─────── */

  // lockbox.js refuses a blob claiming more than MAX_ITERATIONS rather than
  // hanging on it, so a config sealed above that is one the console can never
  // open, and seal.py opening its own work would not notice. This is the
  // silent divergence these two files exist to be checked against.
  // Driven from lockbox.js's own ceiling, not from a number copied in here.
  // Hardcoding it would let the browser lower its limit while seal.py kept
  // the old one, and this suite would stay green while every config sealed
  // between the two became unopenable.
  eq('lockbox.js publishes the ceiling it enforces',
     typeof L.MAX_ITERATIONS, 'number');
  const overCeiling = String(L.MAX_ITERATIONS + 1);

  let ceiling = '';
  try {
    execFileSync(PY, [path.join(ROOT, 'seal.py'),
                      '--host', SECRET.host, '--psk', SECRET.psk,
                      '--iterations', overCeiling,
                      '--out', path.join(work, 'too-many.js'),
                      '--password-file', pwFile], { stdio: 'pipe' });
  } catch (e) {
    ceiling = String(e.stderr || '');
  }
  ok('seal.py refuses an iteration count lockbox.js would reject',
     /refuses to open/.test(ceiling), ceiling.slice(0, 200));

  // And the number it refuses at is the same one. A seal.py with a higher
  // ceiling would accept this and hand back a file the console cannot read.
  ok('and refuses at the same number lockbox.js does',
     ceiling.includes(String(L.MAX_ITERATIONS)), ceiling.slice(0, 200));

  // The other half: one round under the ceiling has to be accepted by both.
  const atCeiling = path.join(work, 'at-ceiling.js');
  execFileSync(PY, [path.join(ROOT, 'seal.py'),
                    '--host', SECRET.host, '--psk', SECRET.psk,
                    '--iterations', String(L.MAX_ITERATIONS),
                    '--out', atCeiling,
                    '--password-file', pwFile], { stdio: 'pipe' });
  const atWin = {};
  new Function('window', fs.readFileSync(atCeiling, 'utf8'))(atWin);
  const atOpened = L.open(PASSWORD, atWin.BRAVIA_DEPLOY_CONFIG);
  eq('a config sealed exactly at the ceiling still opens', atOpened.host, SECRET.host);

  /* ── the guard that keeps a sealed file out of an image ─────────────── */

  // Publishing an image with the sealed config inside turns "somebody on my
  // LAN can attack this offline" into "anybody who can pull the image can",
  // permanently, because registry layers outlive the file. seal.py refuses.
  const ctx = path.join(work, 'context');
  fs.mkdirSync(ctx);
  fs.writeFileSync(path.join(ctx, 'Dockerfile'), 'FROM scratch\n', 'utf8');

  let refused = '';
  try {
    execFileSync(PY, [path.join(ROOT, 'seal.py'),
                      '--host', SECRET.host, '--psk', SECRET.psk,
                      '--out', path.join(ctx, 'deploy-config.js'),
                      '--password-file', pwFile], { stdio: 'pipe' });
  } catch (e) {
    refused = String(e.stderr || '');
  }
  ok('seal.py refuses to write into a Docker build context',
     /build context/.test(refused), refused.slice(0, 200));
  ok('and wrote nothing there',
     !fs.existsSync(path.join(ctx, 'deploy-config.js')));

  /* ── and does not clobber an existing config by accident ────────────── */

  let existing = '';
  try {
    execFileSync(PY, [path.join(ROOT, 'seal.py'),
                      '--host', SECRET.host, '--psk', SECRET.psk,
                      '--out', out, '--password-file', pwFile], { stdio: 'pipe' });
  } catch (e) {
    existing = String(e.stderr || '');
  }
  ok('seal.py will not overwrite without --force', /already exists/.test(existing),
     existing.slice(0, 200));

} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

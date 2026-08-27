'use strict';

/* Known-answer tests for lockbox.js.
 *
 * The primitives are hand-written, so they are checked against Node's own
 * crypto rather than against themselves: a seal-and-open round trip would
 * pass just as happily with a subtly wrong SHA-256. Lengths are chosen to
 * straddle the 64-byte block and the 55/56-byte padding boundary, which is
 * where a hash implementation goes wrong if it is going to.
 *
 * Run: node tests/lockbox.test.js
 */

const nodeCrypto = require('crypto');
const assert = require('assert');

// lockbox.js is browser code; give it the three globals it expects, but
// only where the runtime lacks them. Recent Node defines all three, and
// `crypto` is a getter there, so assigning over it throws under strict
// mode rather than failing quietly.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
}
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const L = require('../lockbox.js');
const { sha256, hmac, pbkdf2, utf8, toB64 } = L._internals;
const hex = (b) => Buffer.from(b).toString('hex');

let passed = 0;
let failed = 0;

function eq(name, got, want) {
  if (got === want) { passed++; console.log('ok   ' + name); return; }
  failed++;
  console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want);
}

function throwsWith(name, message, fn) {
  try {
    fn();
    failed++;
    console.log('FAIL ' + name + ' (nothing thrown)');
  } catch (e) {
    eq(name, e instanceof L.LockboxError ? e.message : 'wrong error type: ' + e, message);
  }
}

/* ── SHA-256 against Node ──────────────────────────────────────────── */

eq('sha256("abc")', hex(sha256(utf8('abc'))),
   'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
  const data = nodeCrypto.randomBytes(n);
  eq('sha256 of ' + n + ' bytes', hex(sha256(new Uint8Array(data))),
     nodeCrypto.createHash('sha256').update(data).digest('hex'));
}

/* ── HMAC-SHA256 against Node, including an over-long key ──────────── */

for (const [keyLen, msgLen] of [[0, 0], [1, 5], [32, 100], [64, 64], [65, 3], [200, 500]]) {
  const key = nodeCrypto.randomBytes(keyLen);
  const msg = nodeCrypto.randomBytes(msgLen);
  eq(`hmac key ${keyLen} msg ${msgLen}`,
     hex(hmac(new Uint8Array(key), new Uint8Array(msg))),
     nodeCrypto.createHmac('sha256', key).update(msg).digest('hex'));
}

/* ── PBKDF2-HMAC-SHA256 against Node ───────────────────────────────── */

for (const [pw, salt, iters, len] of [
  ['password', 'salt', 1, 32],
  ['password', 'salt', 4096, 32],
  ['pw', 'NaCl', 100, 64],          // two output blocks
  ['x', 'y', 7, 100],               // a length that is not a block multiple
]) {
  eq(`pbkdf2 ${pw}/${salt}/${iters}/${len}`,
     hex(pbkdf2(utf8(pw), utf8(salt), iters, len)),
     nodeCrypto.pbkdf2Sync(pw, salt, iters, len, 'sha256').toString('hex'));
}

/* ── seal and open ─────────────────────────────────────────────────── */

const secret = { host: '192.168.1.50', psk: 'sekrit-key', interval: 5 };
const blob = L.seal('hunter2', secret, 1000);

eq('round trip', JSON.stringify(L.open('hunter2', blob)), JSON.stringify(secret));
eq('nothing readable in the sealed blob',
   JSON.stringify(blob).includes('sekrit-key') || JSON.stringify(blob).includes('192.168.1.50'),
   false);

throwsWith('wrong password', 'Access denied', () => L.open('hunter3', blob));
throwsWith('tampered ciphertext', 'Access denied',
           () => L.open('hunter2', { ...blob, ct: toB64(new Uint8Array(20)) }));
throwsWith('tampered iteration count', 'Access denied',
           () => L.open('hunter2', { ...blob, iterations: 999 }));
throwsWith('tampered salt', 'Access denied',
           () => L.open('hunter2', { ...blob, salt: toB64(new Uint8Array(16)) }));
throwsWith('tampered nonce', 'Access denied',
           () => L.open('hunter2', { ...blob, nonce: toB64(new Uint8Array(16)) }));
throwsWith('unknown format', 'Unrecognised configuration format',
           () => L.open('hunter2', { ...blob, v: 2 }));
throwsWith('absurd iteration count', 'Unusable iteration count',
           () => L.open('hunter2', { ...blob, iterations: 99999999 }));

/* A tag is checked at its full length or not at all. Accepting the length
   from the file would let an edited file pick how few bits it has to
   match, and roughly one password in 256 would clear a one-byte tag. */
throwsWith('one-byte tag refused', 'Corrupt configuration',
           () => L.open('hunter2', { ...blob, mac: toB64(Uint8Array.from([0])) }));
throwsWith('empty tag refused', 'Corrupt configuration',
           () => L.open('hunter2', { ...blob, mac: '' }));
{
  let authenticated = 0;
  for (let i = 0; i < 300; i++) {
    try {
      L.open('guess' + i, { ...blob, iterations: 1, mac: toB64(Uint8Array.from([i & 255])) });
      authenticated++;
    } catch (e) {
      if (e.message !== 'Corrupt configuration') authenticated++;
    }
  }
  eq('no password clears a truncated tag', authenticated, 0);
}

/* ── the details that bite ─────────────────────────────────────────── */

const unicode = { host: 'tv.lån', psk: 'påsswørd-キー', interval: 9 };
const unicodeBlob = L.seal('pässwörd-キー', unicode, 200);
eq('non-ASCII survives the round trip',
   JSON.stringify(L.open('pässwörd-キー', unicodeBlob)), JSON.stringify(unicode));

const a = L.seal('same', secret, 200);
const b = L.seal('same', secret, 200);
eq('two seals of one input differ', a.ct !== b.ct && a.salt !== b.salt && a.nonce !== b.nonce, true);

const long = { host: 'h', psk: 'k'.repeat(500), interval: 5 };   // spans keystream blocks
eq('a payload longer than one keystream block round trips',
   JSON.stringify(L.open('pw', L.seal('pw', long, 200))), JSON.stringify(long));

eq('sealing uses the documented stretching', L.DEFAULT_ITERATIONS, 120000);

/* The unlock cost is a user-facing number: the README quotes it and the
   dialog blocks for it. Time it rather than trusting the constant. */
const started = Date.now();
L.open('hunter2', L.seal('hunter2', secret));
const elapsed = Date.now() - started;
console.log(`\n     two key derivations at ${L.DEFAULT_ITERATIONS} iterations: ${elapsed} ms`);
assert.ok(elapsed < 20000, 'key derivation is implausibly slow: ' + elapsed + ' ms');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

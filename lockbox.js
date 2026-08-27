'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Lockbox: password-protected deployment config for Bravia Console.

   Seals {host, psk, interval} into a blob that pack.html writes out as
   deploy-config.js, and opens it again in the browser when the right
   password is typed. Self-contained SHA-256 / HMAC / PBKDF2 rather than
   WebCrypto, because crypto.subtle only exists in a secure context and
   this app is deliberately served over plain http:// on a LAN, where it
   would be missing. No build step, no dependencies, same as the rest.

   Format: PBKDF2-HMAC-SHA256 stretches the password into an encryption
   key and a MAC key. The plaintext is XORed with a keystream of
   SHA-256(encKey || nonce || counter) blocks, and the header plus the
   ciphertext is authenticated with HMAC-SHA256. A wrong password fails
   that MAC check, which is what "access denied" is reading.

   The bar here is "not readable by someone who just found the page on
   the LAN", not "resists an offline attack by someone holding the file".
   ═══════════════════════════════════════════════════════════════════════ */

(function (global) {

const MAGIC = 'bravia-lockbox-1';
const DEFAULT_ITERATIONS = 120000;
const MAX_ITERATIONS = 2000000;   // refuse an absurd header instead of hanging
const SALT_LEN = 16;
const NONCE_LEN = 16;
const MAC_LEN = 16;

/* ── SHA-256 ───────────────────────────────────────────────────────── */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const W = new Uint32Array(64);

/* One 64-byte block into the running state, in place. */
function compress(H, m, off) {
  for (let i = 0; i < 16; i++) {
    W[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) |
           (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
  }
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15], y = W[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3];
  let e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
  H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
  H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

/* Finish a digest whose state has already absorbed `prefixLen` bytes.
   With prefixLen 0 that is a plain SHA-256; HMAC uses it to resume from
   a precomputed pad state. */
function digestFrom(state, data, prefixLen) {
  const H = state.slice();
  const len = data.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const bits = (prefixLen + len) * 8;
  const hi = Math.floor(bits / 4294967296);
  const lo = bits >>> 0;
  buf[total - 8] = (hi >>> 24) & 0xff; buf[total - 7] = (hi >>> 16) & 0xff;
  buf[total - 6] = (hi >>> 8) & 0xff;  buf[total - 5] = hi & 0xff;
  buf[total - 4] = (lo >>> 24) & 0xff; buf[total - 3] = (lo >>> 16) & 0xff;
  buf[total - 2] = (lo >>> 8) & 0xff;  buf[total - 1] = lo & 0xff;
  for (let off = 0; off < total; off += 64) compress(H, buf, off);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[4 * i] = (H[i] >>> 24) & 0xff;     out[4 * i + 1] = (H[i] >>> 16) & 0xff;
    out[4 * i + 2] = (H[i] >>> 8) & 0xff;  out[4 * i + 3] = H[i] & 0xff;
  }
  return out;
}

function sha256(data) { return digestFrom(INIT, data, 0); }

/* ── HMAC-SHA256 ───────────────────────────────────────────────────── */

/* The two pad blocks are identical for every message under one key, so
   compress them once: PBKDF2 then costs two block compressions per
   iteration instead of four. */
function hmacKey(key) {
  if (key.length > 64) key = sha256(key);
  const ipad = new Uint8Array(64), opad = new Uint8Array(64);
  ipad.set(key); opad.set(key);
  for (let i = 0; i < 64; i++) { ipad[i] ^= 0x36; opad[i] ^= 0x5c; }
  const si = INIT.slice(); compress(si, ipad, 0);
  const so = INIT.slice(); compress(so, opad, 0);
  return { si, so };
}

function hmacWith(ctx, data) {
  return digestFrom(ctx.so, digestFrom(ctx.si, data, 64), 64);
}

function hmac(key, data) { return hmacWith(hmacKey(key), data); }

/* ── PBKDF2-HMAC-SHA256 ────────────────────────────────────────────── */

function pbkdf2(password, salt, iterations, dkLen) {
  const ctx = hmacKey(password);
  const out = new Uint8Array(dkLen);
  const msg = new Uint8Array(salt.length + 4);
  msg.set(salt);
  for (let block = 1, pos = 0; pos < dkLen; block++, pos += 32) {
    msg[salt.length] = (block >>> 24) & 0xff;
    msg[salt.length + 1] = (block >>> 16) & 0xff;
    msg[salt.length + 2] = (block >>> 8) & 0xff;
    msg[salt.length + 3] = block & 0xff;
    let u = hmacWith(ctx, msg);
    const t = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmacWith(ctx, u);
      for (let j = 0; j < 32; j++) t[j] ^= u[j];
    }
    out.set(t.subarray(0, Math.min(32, dkLen - pos)), pos);
  }
  return out;
}

/* ── bytes, text, base64 ───────────────────────────────────────────── */

const utf8 = (s) => new TextEncoder().encode(s);
const fromUtf8 = (b) => new TextDecoder().decode(b);

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  global.crypto.getRandomValues(b);   // available without a secure context
  return b;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ── the cipher itself ─────────────────────────────────────────────── */

function keystreamXor(encKey, nonce, data) {
  const out = new Uint8Array(data.length);
  const seed = new Uint8Array(encKey.length + nonce.length + 4);
  seed.set(encKey); seed.set(nonce, encKey.length);
  const ctrAt = encKey.length + nonce.length;
  for (let pos = 0, counter = 0; pos < data.length; pos += 32, counter++) {
    seed[ctrAt] = (counter >>> 24) & 0xff;
    seed[ctrAt + 1] = (counter >>> 16) & 0xff;
    seed[ctrAt + 2] = (counter >>> 8) & 0xff;
    seed[ctrAt + 3] = counter & 0xff;
    const block = sha256(seed);
    const n = Math.min(32, data.length - pos);
    for (let i = 0; i < n; i++) out[pos + i] = data[pos + i] ^ block[i];
  }
  return out;
}

/* Everything a reader needs in order to reproduce the keys is signed, so
   a tampered iteration count or salt reads as a wrong password rather
   than as a hang or as a silently different key. */
function macInput(iterations, salt, nonce, ct) {
  const header = new Uint8Array(4);
  header[0] = (iterations >>> 24) & 0xff; header[1] = (iterations >>> 16) & 0xff;
  header[2] = (iterations >>> 8) & 0xff;  header[3] = iterations & 0xff;
  return concat(utf8(MAGIC), header, salt, nonce, ct);
}

function deriveKeys(password, salt, iterations) {
  const dk = pbkdf2(utf8(password), salt, iterations, 64);
  return { encKey: dk.subarray(0, 32), macKey: dk.subarray(32, 64) };
}

/* Seal a plain object into a blob that is safe to serve to anyone. */
function seal(password, obj, iterations) {
  const iters = iterations || DEFAULT_ITERATIONS;
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const { encKey, macKey } = deriveKeys(password, salt, iters);
  const ct = keystreamXor(encKey, nonce, utf8(JSON.stringify(obj)));
  const mac = hmac(macKey, macInput(iters, salt, nonce, ct)).subarray(0, MAC_LEN);
  return {
    v: 1,
    kdf: 'pbkdf2-hmac-sha256',
    iterations: iters,
    salt: toB64(salt),
    nonce: toB64(nonce),
    ct: toB64(ct),
    mac: toB64(mac),
  };
}

class LockboxError extends Error {}

/* Open a sealed blob. Throws LockboxError for a wrong password and for a
   blob this build cannot read; the caller shows the same denial either
   way, since telling the two apart helps nobody but a guesser. */
function open(password, blob) {
  if (!blob || typeof blob !== 'object') throw new LockboxError('No configuration to open');
  if (blob.v !== 1 || blob.kdf !== 'pbkdf2-hmac-sha256') {
    throw new LockboxError('Unrecognised configuration format');
  }
  const iters = blob.iterations | 0;
  if (iters < 1 || iters > MAX_ITERATIONS) throw new LockboxError('Unusable iteration count');

  let salt, nonce, ct, mac;
  try {
    salt = fromB64(blob.salt); nonce = fromB64(blob.nonce);
    ct = fromB64(blob.ct); mac = fromB64(blob.mac);
  } catch { throw new LockboxError('Corrupt configuration'); }
  // The tag length is fixed by this format rather than taken from the
  // file: a shorter one would be checked over fewer bits, which is an
  // edited file choosing how hard it is to authenticate.
  if (mac.length !== MAC_LEN) throw new LockboxError('Corrupt configuration');

  const { encKey, macKey } = deriveKeys(password, salt, iters);
  const want = hmac(macKey, macInput(iters, salt, nonce, ct)).subarray(0, MAC_LEN);
  if (!equalBytes(mac, want)) throw new LockboxError('Access denied');

  try {
    return JSON.parse(fromUtf8(keystreamXor(encKey, nonce, ct)));
  } catch { throw new LockboxError('Corrupt configuration'); }
}

global.Lockbox = {
  seal, open, LockboxError,
  DEFAULT_ITERATIONS,
  // Exposed so the primitives can be checked against published test
  // vectors. A seal-and-open round trip, which is all pack.html does
  // before handing over a file, would pass even on a wrong SHA-256.
  _internals: { sha256, hmac, pbkdf2, utf8, toB64 },
};

})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.Lockbox;

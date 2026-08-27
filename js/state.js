'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, state.

   Everything the rest of the app reads and writes: the session state, the
   pre-shared key under its mask, what is remembered between visits, and
   the base address requests go to.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

const LS_KEY = 'bravia-console-config';
const LS_INTERVAL_KEY = 'bravia-console-interval';
const RPC_TIMEOUT_MS = 8000;

/* ── state ─────────────────────────────────────────────────────────── */

let cfg = null;                 // {host, interval}; the PSK is held separately
let sealedCfg = null;           // sealed blob from deploy-config.js, if deployed
let locked = false;             // sealed config present and not yet opened
let proxyDetected = false;      // page served by bundled proxy.js
let apiMap = null;              // {service: {method: Set(versions)}} from discovery
let unsupported = new Set();    // "service.method" learned from errors 12/14/501
let versionOverride = new Map();// "service.method" → version that actually worked
let irccCodes = [];             // [{name, value}] from getRemoteControllerInfo
let apps = [];                  // [{title, uri, icon}]
let powerState = 'unknown';     // 'active' | 'standby' | 'unknown'
let lastActiveFetch = false;    // whether active-only data has been loaded since power-on
let pollTimer = null;
let retryTimer = null;
// Each connect() bumps the epoch; async work captures it on entry and discards
// its results if a newer session started meanwhile, so a stale connect or poll
// can never repaint state that belongs to a fresher connection.
let epoch = 0;
let pollInFlight = null;        // epoch of the poll currently running, or null
let rpcId = 1;

const $ = (id) => document.getElementById(id);

/* ── the pre-shared key in memory ──────────────────────────────────── */

/* The key is never held as a readable string. It sits XORed under a mask
   minted fresh on every page load, and is unmasked only for the moment a
   request needs it. This is obfuscation and nothing more: any script
   running in this page can undo it. What it buys is that the key is not
   sitting in plain sight in a heap snapshot, a logged copy of cfg, or a
   devtools scope view of an idle tab. */
let pskMasked = null;           // Uint8Array of key XOR mask
let pskMask = null;             // Uint8Array, same length, per page load

function setPsk(str) {
  clearPsk();
  const bytes = new TextEncoder().encode(str || '');
  const mask = new Uint8Array(bytes.length);
  crypto.getRandomValues(mask);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i];
  pskMasked = bytes;
  pskMask = mask;
}

function getPsk() {
  if (!pskMasked) return '';
  const out = new Uint8Array(pskMasked.length);
  for (let i = 0; i < out.length; i++) out[i] = pskMasked[i] ^ pskMask[i];
  return new TextDecoder().decode(out);
}

function clearPsk() {
  if (pskMasked) pskMasked.fill(0);
  if (pskMask) pskMask.fill(0);
  pskMasked = pskMask = null;
}

/* ── config persistence ────────────────────────────────────────────── */

function loadCfg() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
}

/* Only ever called for a hand-entered config. A deployed build keeps the
   address and key in memory alone, so that closing the tab is enough to
   put them back behind the password. */
function saveCfg(c) {
  localStorage.setItem(LS_KEY, JSON.stringify({ ...c, psk: getPsk() }));
}

/* The refresh interval is a preference, not a secret, so it is the one
   thing a deployed build does remember between visits. */
function loadStoredInterval() {
  const n = parseInt(localStorage.getItem(LS_INTERVAL_KEY), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function saveStoredInterval(n) { localStorage.setItem(LS_INTERVAL_KEY, String(n)); }

function apiBase() {
  if (proxyDetected || !cfg.host) return '';
  if (/^https?:\/\//i.test(cfg.host)) return cfg.host.replace(/\/+$/, '');
  return 'http://' + cfg.host;
}

'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, shell.

   The frame around the cards: the connection pill, the banner, toasts, the
   standby mask, and the guard that turns a failed command into a message
   rather than a silence.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── rendering: header & shell ─────────────────────────────────────── */

function setPill(kind, text) {
  const pill = $('conn-pill');
  pill.className = 'pill pill-' + kind;
  pill.textContent = text;
}

function showBanner(kind, text) {
  const b = $('banner');
  b.className = kind === 'err' ? 'err' : '';
  b.textContent = text;
  b.hidden = false;
}
function hideBanner() { $('banner').hidden = true; }

function applyStandbyMask() {
  const standby = powerState !== 'active';
  for (const id of ['card-playing', 'card-volume', 'card-inputs', 'card-apps',
                    'card-keys', 'card-text', 'card-picture', 'card-sound', 'card-speaker']) {
    $(id).classList.toggle('disabled-standby', standby);
  }
}

/* Shared guard for every renderer: never tear down DOM the user is
   interacting with (focused button, select, slider, input). */
function interacting(container) {
  const el = document.activeElement;
  return !!container && !!el && el !== document.body && container.contains(el);
}

function toast(msg, ok = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (ok ? ' ok' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function guard(promise, okMsg) {
  return promise
    .then(() => { if (okMsg) toast(okMsg, true); nudge(); })
    .catch(e => {
      // rpc() has already recorded unsupported codes (12/14/501, HTTP or
      // JSON-RPC) in the `unsupported` set, so the re-poll below hides them.
      if (isUnsupportedCode(e.code)) {
        toast('This display does not support that operation; control hidden.');
        pollOnce(true);
      } else {
        toast(e.message || 'Command failed');
      }
    });
}

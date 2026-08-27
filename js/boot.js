'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, boot.

   Startup: work out what kind of build this is, wire the page up, and hand
   over to either the settings dialog, the password prompt, or a stored
   configuration. Loaded last, and the only file that runs anything.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── boot ──────────────────────────────────────────────────────────── */

async function detectProxy() {
  if (location.protocol === 'file:') return false;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('/__proxy', { signal: ctrl.signal });
    if (!res.ok) return false;
    const j = await res.json();
    return j && j.proxy === true;
  } catch { return false; }
}

async function main() {
  // Settle what kind of build this is before anything can await. Probing
  // for the proxy takes a moment, and a click on Settings during it would
  // otherwise be answered as though the build were an ordinary one, which
  // is the one thing the lock exists to prevent.
  //
  // deploy-config.js is optional: without it, or with the placeholder the
  // repo ships, this is the ordinary app that asks for an address and a
  // key and remembers them.
  sealedCfg = (typeof window.BRAVIA_DEPLOY_CONFIG === 'object' && window.BRAVIA_DEPLOY_CONFIG)
    ? window.BRAVIA_DEPLOY_CONFIG : null;
  locked = deployed();
  if (locked) $('empty-state').hidden = true;

  initSettingsDialog();
  initUnlockDialog();
  initCollapsibleCards();
  $('btn-settings').onclick = () => openSettings();
  $('btn-settings-empty').onclick = () => openSettings();
  $('btn-refresh').onclick = () => { pollOnce(true); refreshSettingsCards(); };
  $('app-filter').addEventListener('input', renderApps);
  $('btn-terminate').onclick = () =>
    guard(rpc('appControl', 'terminateApps', []), 'Asked TV to close background apps');
  $('text-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('text-input').value;
    guard(rpc('appControl', 'setTextForm', [text], '1.0'), 'Text sent');
    $('text-input').value = '';
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollOnce(); });

  proxyDetected = await detectProxy();

  if (deployed()) {
    // Drop anything an earlier, unsealed use of this browser left behind,
    // so that a deployed page really does hold nothing between visits.
    localStorage.removeItem(LS_KEY);
    openUnlock();
    return;
  }

  const stored = loadCfg();
  if (stored) {
    setPsk(stored.psk);
    cfg = { host: stored.host, interval: stored.interval };
    $('empty-state').hidden = true;
    connect();
  } else {
    openSettings();
  }
}

main();

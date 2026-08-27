'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, session.

   The life of a connection: the opening sequence, the static data fetched
   once per connect or wake, and the poll loop that keeps the fast-moving
   state current.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── connection sequence ───────────────────────────────────────────── */

async function connect() {
  const my = ++epoch;
  stopPolling();
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  unsupported = new Set();
  versionOverride = new Map();
  powerState = 'unknown';
  lastActiveFetch = false;
  setPill('busy', 'CONNECTING');
  hideBanner();

  let sysInfo = null;
  try {
    sysInfo = (await rpc('system', 'getSystemInformation', [], '1.0'))[0];
  } catch (e) {
    if (my !== epoch) return;   // a newer connect took over while we waited
    if (e.kind === 'auth') {
      setPill('err', 'AUTH FAILED');
      openSettings(authFailureText());
      return;
    }
    if (e.kind === 'network') {
      setPill('err', 'UNREACHABLE');
      showBanner('err', proxyDetected
        ? 'The proxy could not reach the display. Check that the TV is powered, on the ' +
          'network, and that the proxy was started with the right address.'
        : 'Could not reach the display at ' + (apiBase() || 'this page’s origin') + '.\n' +
          '• If the TV is on and the address is right, the browser probably blocked the ' +
          'cross-origin request (many Bravia displays never answer CORS preflights).\n' +
          '• Fix: serve this app through the bundled proxy (python proxy.py <tv-ip> or ' +
          'node proxy.js <tv-ip>) and open http://localhost:8585; see README.md. ' +
          'Failing that, launch a browser with web security disabled.');
      $('empty-state').hidden = true;
      retryTimer = setTimeout(connect, Math.max(5, cfg.interval) * 1000);
      return;
    }
    // Some models refuse getSystemInformation in deep standby; keep going.
  }
  if (my !== epoch) return;

  $('tv-ident').textContent = sysInfo
    ? [sysInfo.name, sysInfo.model].filter(Boolean).join(' · ') + ' @ ' + (cfg.host || 'proxy')
    : (cfg.host || 'proxy');

  await discoverApi();
  if (my !== epoch) return;

  // Static-ish data (refetched on power-on transitions).
  await Promise.all([loadRemoteInfo(), loadApps()]);
  if (my !== epoch) return;
  renderSystem(sysInfo);

  $('empty-state').hidden = true;
  await pollOnce(true);
  if (my !== epoch) return;
  startPolling();
}

async function loadRemoteInfo() {
  const my = epoch;
  irccCodes = [];
  if (!supports('system', 'getRemoteControllerInfo')) return;
  try {
    const r = await rpc('system', 'getRemoteControllerInfo', []);
    if (my !== epoch) return;
    irccCodes = r[1] || [];
  } catch { /* hidden below */ }
  if (my !== epoch) return;
  renderKeys();
}

async function loadApps() {
  const my = epoch;
  apps = [];
  if (!supports('appControl', 'getApplicationList')) { renderApps(); return; }
  try {
    const r = (await rpc('appControl', 'getApplicationList', []))[0] || [];
    if (my !== epoch) return;
    apps = r;
  } catch { /* standby or unsupported → leave empty */ }
  if (my !== epoch) return;
  renderApps();
}

/* ── polling ───────────────────────────────────────────────────────── */

function startPolling() {
  stopPolling();
  const ms = Math.max(1, cfg.interval) * 1000;
  pollTimer = setInterval(() => { pollOnce(); }, ms);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollOnce(force = false) {
  const my = epoch;
  // Nothing to poll before there is a config: returning to a tab that is
  // still at the settings or password prompt must not paint a failure.
  if (!cfg) return;
  if (document.hidden && !force) return;
  // Skip only if a poll for THIS session is already running; a stale poll
  // from an older epoch must not block (its writes are discarded anyway).
  if (pollInFlight === my) return;
  pollInFlight = my;
  try {
    let status;
    try {
      status = (await rpc('system', 'getPowerStatus', []))[0].status;
    } catch (e) {
      if (my !== epoch) return;
      if (e.kind === 'auth') { setPill('err', 'AUTH FAILED'); stopPolling(); openSettings(authFailureText()); return; }
      setPill('err', 'UNREACHABLE');
      return;
    }
    if (my !== epoch) return;

    const wasActive = powerState === 'active';
    powerState = status;
    setPill(status === 'active' ? 'on' : 'standby', status === 'active' ? 'ON' : 'STANDBY');
    renderPower();
    applyStandbyMask();

    if (status !== 'active') return;

    // Re-arm static data after wake-up.
    if (!wasActive || !lastActiveFetch) {
      lastActiveFetch = true;
      loadApps();
      if (!irccCodes.length) loadRemoteInfo();
      refreshSettingsCards();
    }

    const fresh = (fn) => (r) => { if (my === epoch) fn(r); };
    const jobs = [];
    if (supports('audio', 'getVolumeInformation'))
      jobs.push(rpc('audio', 'getVolumeInformation', [])
        .then(fresh(r => renderVolume(r[0]))).catch(fresh(() => renderVolume(null))));
    if (supports('avContent', 'getPlayingContentInfo'))
      jobs.push(rpc('avContent', 'getPlayingContentInfo', [])
        .then(fresh(r => renderPlaying(r[0]))).catch(fresh(() => renderPlaying(null))));
    if (supports('avContent', 'getCurrentExternalInputsStatus'))
      jobs.push(rpc('avContent', 'getCurrentExternalInputsStatus', [], bestVersion('avContent', 'getCurrentExternalInputsStatus', '1.1'))
        .then(fresh(r => renderInputs(r[0]))).catch(fresh(() => renderInputs(null))));
    if (supports('appControl', 'getApplicationStatusList'))
      jobs.push(rpc('appControl', 'getApplicationStatusList', [])
        .then(fresh(r => renderTextCard(r[0]))).catch(fresh(() => renderTextCard(null))));
    await Promise.all(jobs);
  } finally {
    if (pollInFlight === my) pollInFlight = null;
  }
}

/* Slower-moving settings, fetched on connect / wake / after edits. */
function refreshSettingsCards() {
  loadGenericSettings('video', 'getPictureQualitySettings', 'setPictureQualitySettings', 'card-picture', 'picture-body');
  loadGenericSettings('audio', 'getSoundSettings', 'setSoundSettings', 'card-sound', 'sound-body');
  loadGenericSettings('audio', 'getSpeakerSettings', 'setSpeakerSettings', 'card-speaker', 'speaker-body');
  loadPowerExtras();
}

/* Kick a quick refresh shortly after a user action so the UI reflects it. */
function nudge(delay = 450) { setTimeout(() => pollOnce(true), delay); }

'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, dialogs.

   The two dialogs: connection settings, and the password prompt a build
   deployed with a sealed configuration starts at. Logging out lives here
   too, since it is the prompt getting its page back.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── settings dialog ───────────────────────────────────────────────── */

/* True when this copy of the app was deployed with a sealed config, in
   which case the address and key come from the password prompt and are
   not the user's to edit. */
const deployed = () => !!sealedCfg;

function authFailureText() {
  return deployed()
    ? 'The display rejected the pre-shared key held in this deployment. The key is ' +
      'wrong, or the TV is no longer set to "Normal and Pre-Shared Key". Whoever ' +
      'packaged this page has to repackage it.'
    : 'The display rejected the pre-shared key. Check the PSK and that ' +
      'authentication is set to "Normal and Pre-Shared Key" on the TV.';
}

function openSettings(errorMsg) {
  // Nothing is settable from behind the lock, and the dialog assumes a
  // config that does not exist yet.
  if (locked) return;
  const dlg = $('settings-dialog');
  // A deployed build shows the interval and nothing else: there is no
  // point offering fields whose values it will not keep, and echoing the
  // key back into a text box would undo the point of sealing it.
  $('settings-connection').hidden = deployed();
  $('deploy-note').hidden = !deployed();
  $('btn-logout').hidden = !deployed();
  // Nothing to reconnect when the interval is all that can change.
  $('btn-cfg-save').textContent = deployed() ? 'Save' : 'Save & Connect';
  if (!deployed()) {
    $('cfg-host').value = cfg?.host || '';
    $('cfg-psk').value = getPsk();
    $('proxy-hint').textContent = proxyDetected
      ? 'Bundled proxy detected, so requests are routed through this page’s own ' +
        'origin and the address here is informational.'
      : $('proxy-hint').textContent;
  }
  $('cfg-interval').value = cfg?.interval || 5;
  $('btn-cfg-cancel').disabled = !cfg;
  const err = $('settings-error');
  if (errorMsg) { err.textContent = errorMsg; err.hidden = false; }
  else err.hidden = true;
  if (!dlg.open) dlg.showModal();
}

function initSettingsDialog() {
  $('settings-form').addEventListener('submit', (e) => {
    const interval = Math.max(1, parseInt($('cfg-interval').value, 10) || 5);
    if (deployed()) {
      // Nothing to reconnect for: only the poll cadence can have changed.
      if (cfg) cfg.interval = interval;
      saveStoredInterval(interval);
      if (pollTimer) startPolling();
      return;
    }
    const host = $('cfg-host').value.trim();
    if (!host && !proxyDetected) {
      e.preventDefault();
      const err = $('settings-error');
      err.textContent = 'Enter the display’s hostname or IP address (or serve the app through the bundled proxy).';
      err.hidden = false;
      return;
    }
    setPsk($('cfg-psk').value);
    cfg = { host, interval };
    saveCfg(cfg);
    connect();
  });
  $('app-version').textContent = 'Bravia Console ' + APP_VERSION;
  $('btn-cfg-cancel').onclick = () => $('settings-dialog').close();
  $('btn-logout').onclick = logout;
  $('btn-psk-toggle').onclick = () => {
    const inp = $('cfg-psk');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('btn-psk-toggle').textContent = inp.type === 'password' ? 'show' : 'hide';
  };
  // A dialog with no config yet must not be dismissible via Esc.
  $('settings-dialog').addEventListener('cancel', (e) => { if (!cfg) e.preventDefault(); });
}

/* ── sealed deployment config ──────────────────────────────────────── */

/* Reloading is the whole logout: nothing decrypted was written anywhere
   that survives it, so the fresh page comes up locked again. The wipes
   below only shorten the window before that happens. */
function logout() {
  stopPolling();
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  epoch++;
  clearPsk();
  cfg = null;
  $('unlock-password').value = '';
  $('cfg-psk').value = '';
  location.reload();
}

function openUnlock(errorMsg) {
  const dlg = $('unlock-dialog');
  const err = $('unlock-error');
  if (errorMsg) { err.textContent = errorMsg; err.hidden = false; }
  else err.hidden = true;
  if (!dlg.open) dlg.showModal();
  $('unlock-password').focus();
}

/* Stretching the password takes a beat, so let the "Checking" state
   reach the screen before the main thread disappears into the KDF.
   Raced against a timer because a page that is not being painted (a
   hidden tab, a restored session) never runs the frame callback, and an
   unlock that waits for a frame that is never coming is worse than one
   that skips the repaint. */
function paintPause() {
  return new Promise(resolve => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 60);
  });
}

async function attemptUnlock() {
  const btn = $('btn-unlock');
  const input = $('unlock-password');
  const password = input.value;
  if (!password) { openUnlock('Enter the password for this deployment.'); return; }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Checking…';
  $('unlock-error').hidden = true;
  await paintPause();

  let secret = null;
  try {
    secret = Lockbox.open(password, sealedCfg);
  } catch {
    // A wrong password and an unreadable file read the same from out
    // here, deliberately: the difference helps nobody but a guesser.
    btn.disabled = false;
    btn.textContent = label;
    input.value = '';
    openUnlock('Access denied.');
    return;
  }
  btn.disabled = false;
  btn.textContent = label;
  input.value = '';
  setPsk(secret.psk || '');
  // A locally chosen interval outranks the packaged one: it is the one
  // setting this mode still lets the user own.
  cfg = {
    host: String(secret.host || ''),
    interval: Math.max(1, loadStoredInterval() || parseInt(secret.interval, 10) || 5),
  };
  locked = false;
  $('unlock-dialog').close();
  $('empty-state').hidden = true;
  connect();
}

function initUnlockDialog() {
  $('unlock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    attemptUnlock();
  });
  // Locked is the resting state of a deployed build; Esc cannot leave it.
  $('unlock-dialog').addEventListener('cancel', (e) => { if (locked) e.preventDefault(); });
  // Belt and braces: whatever route a close request took, a build that is
  // still locked goes straight back to the prompt. attemptUnlock clears
  // `locked` before it closes the dialog, so a real unlock passes through.
  //
  // showModal() around a dialog's own close event is unreliable on
  // Chromium: called from inside the handler it does nothing at all, and
  // neither throws nor reopens, while a deferred call is honoured only
  // most of the time. So the prompt is put back one task later and the
  // result is checked, and if it did not take, the page reloads. Nothing
  // decrypted outlives a reload, so what comes back is locked too, which
  // is the only outcome that actually matters here.
  $('unlock-dialog').addEventListener('close', () => {
    if (!locked) return;
    setTimeout(() => {
      if (!locked) return;
      if (!$('unlock-dialog').open) openUnlock();
      if (!$('unlock-dialog').open) location.reload();
    }, 0);
  });
}

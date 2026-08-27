'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console: single-page controller for Sony Bravia displays.
   Talks JSON-RPC over HTTP to http://<host>/sony/<service> with the
   X-Auth-PSK pre-shared-key header. No build step, no dependencies.
   ═══════════════════════════════════════════════════════════════════════ */

const LS_KEY = 'bravia-console-config';
const RPC_TIMEOUT_MS = 8000;

/* ── state ─────────────────────────────────────────────────────────── */

let cfg = null;                 // {host, psk, interval}
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

/* ── config persistence ────────────────────────────────────────────── */

function loadCfg() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
}
function saveCfg(c) { localStorage.setItem(LS_KEY, JSON.stringify(c)); }

function apiBase() {
  if (proxyDetected || !cfg.host) return '';
  if (/^https?:\/\//i.test(cfg.host)) return cfg.host.replace(/\/+$/, '');
  return 'http://' + cfg.host;
}

/* ── transport ─────────────────────────────────────────────────────── */

class RpcError extends Error {
  constructor(kind, code, message) {
    super(message);
    this.kind = kind;   // 'auth' | 'network' | 'api'
    this.code = code;   // JSON-RPC error code or HTTP status
  }
}

const isUnsupportedCode = (code) => code === 12 || code === 14 || code === 501;

/* Shared HTTP transport: base URL, timeout, and status→error mapping for
   both JSON-RPC and the SOAP IRCC endpoint. */
async function braviaFetch(path, headers, body) {
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    res = await fetch(apiBase() + path, {
      method: 'POST', headers, body, signal: ctrl.signal,
    });
  } catch (e) {
    throw new RpcError('network', 0, e.name === 'AbortError'
      ? 'Request timed out' : 'Network request failed');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403) throw new RpcError('auth', 403, 'Authentication rejected (403)');
  if (res.status === 502) throw new RpcError('network', 502, 'Proxy could not reach the TV');
  if (!res.ok) throw new RpcError('api', res.status, 'HTTP ' + res.status);
  return res;
}

/* One JSON-RPC attempt at a specific version; no capability bookkeeping. */
async function rpcRaw(service, method, params, version) {
  const res = await braviaFetch('/sony/' + service,
    { 'X-Auth-PSK': cfg.psk, 'Content-Type': 'application/json' },
    JSON.stringify({ method, params, version, id: rpcId++ }));
  const json = await res.json();
  if (json.error) {
    const [code, msg] = json.error;
    if (code === 403) throw new RpcError('auth', 403, msg || 'Forbidden');
    throw new RpcError('api', code, msg || ('API error ' + code));
  }
  return json.result !== undefined ? json.result : json.results;
}

function altVersions(service, method, tried) {
  const advertised = apiMap && apiMap[service] && apiMap[service][method];
  const pool = advertised && advertised.size ? [...advertised].sort() : ['1.0', '1.1'];
  return pool.filter(v => v !== tried).slice(0, 2);
}

async function rpc(service, method, params = [], version) {
  const key = service + '.' + method;
  version = versionOverride.get(key) || version || bestVersion(service, method) || '1.0';
  try {
    return await rpcRaw(service, method, params, version);
  } catch (e) {
    if (e.code === 14) {
      // Unsupported *version*, not a missing method: retry the alternatives
      // before writing the whole method off for the session.
      for (const alt of altVersions(service, method, version)) {
        try {
          const r = await rpcRaw(service, method, params, alt);
          versionOverride.set(key, alt);
          return r;
        } catch (e2) {
          if (e2.code !== 14) {
            if (isUnsupportedCode(e2.code)) unsupported.add(key);
            throw e2;
          }
        }
      }
      unsupported.add(key);
    } else if (isUnsupportedCode(e.code)) {
      unsupported.add(key);   // covers HTTP-level 501 as well as JSON-RPC errors
    }
    throw e;
  }
}

/* Sends an infrared-over-IP key code via the SOAP IRCC endpoint. */
async function sendIrcc(code) {
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">' +
    '<IRCCCode>' + code + '</IRCCCode>' +
    '</u:X_SendIRCC></s:Body></s:Envelope>';
  await braviaFetch('/sony/ircc', {
    'X-Auth-PSK': cfg.psk,
    'Content-Type': 'text/xml; charset=UTF-8',
    'SOAPAction': '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
  }, body);
}

/* ── capability discovery ──────────────────────────────────────────── */

const SERVICES = ['system', 'audio', 'avContent', 'appControl', 'video', 'videoScreen', 'guide'];

function supports(service, method) {
  if (unsupported.has(service + '.' + method)) return false;
  if (!apiMap) return true;                       // discovery failed → optimistic
  return !!(apiMap[service] && apiMap[service][method]);
}

function bestVersion(service, method, prefer) {
  const versions = apiMap && apiMap[service] && apiMap[service][method];
  if (!versions || !versions.size) return prefer;
  if (prefer && versions.has(prefer)) return prefer;
  return [...versions].sort().pop();
}

async function discoverApi() {
  apiMap = null;
  try {
    const r = await rpc('guide', 'getSupportedApiInfo', [{ services: SERVICES }], '1.0');
    const map = {};
    for (const svc of r[0]) {
      const methods = {};
      for (const m of svc.apis || []) {
        methods[m.name] = new Set((m.versions || []).map(v => v.version));
      }
      map[svc.service] = methods;
    }
    apiMap = map;
    return;
  } catch { /* fall through to per-service probing */ }

  const map = {};
  await Promise.all(SERVICES.map(async (service) => {
    try {
      const r = await rpc(service, 'getMethodTypes', [''], '1.0');
      const methods = {};
      for (const row of r) {
        const [name, , , version] = row;
        (methods[name] = methods[name] || new Set()).add(version);
      }
      map[service] = methods;
    } catch { /* service absent on this model */ }
  }));
  if (Object.keys(map).length) apiMap = map;
}

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
      openSettings('The display rejected the pre-shared key. Check the PSK and that ' +
        'authentication is set to "Normal and Pre-Shared Key" on the TV.');
      return;
    }
    if (e.kind === 'network') {
      setPill('err', 'UNREACHABLE');
      showBanner('err', proxyDetected
        ? 'The proxy could not reach the display. Check that the TV is powered, on the ' +
          'network, and that the proxy was started with the right address.'
        : 'Could not reach the display at ' + (apiBase() || 'this page’s origin') + '.\n' +
          '• If the TV is on and the address is right, the browser probably blocked the ' +
          'cross-origin request (Bravia displays don’t answer CORS preflights).\n' +
          '• Fix: serve this app through the bundled proxy (python proxy.py <tv-ip> or ' +
          'node proxy.js <tv-ip>) and open http://localhost:8585, or launch a browser ' +
          'with web security disabled. See README.md.');
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
      if (e.kind === 'auth') { setPill('err', 'AUTH FAILED'); stopPolling(); openSettings('Pre-shared key was rejected.'); return; }
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

/* ── rendering: power card ─────────────────────────────────────────── */

function renderPower() {
  const card = $('card-power');
  card.hidden = false;
  $('power-sub').textContent = 'system.getPowerStatus';

  // The card body has two halves: #power-main (rebuilt on every poll) and
  // #power-extras (settings selects, owned solely by loadPowerExtras so a
  // poll tick never races the async fill or fires extra RPCs).
  const body = $('power-body');
  if (!$('power-main')) {
    body.innerHTML = '<div id="power-main"></div><div id="power-extras"></div>';
  }
  const main = $('power-main');

  // The structure depends only on which methods the TV supports, so build it
  // once and repaint the live values every poll. Rebuilding wholesale would
  // destroy a button the user has just clicked (it keeps focus), which used
  // to freeze this card until focus happened to move elsewhere.
  const shape = [supports('system', 'setPowerStatus'),
                 supports('system', 'requestReboot')].join(',');
  if (main.dataset.shape !== shape && !interacting(main)) {
    main.dataset.shape = shape;
    buildPowerControls(main);
  }
  paintPowerState(main);
}

function buildPowerControls(main) {
  main.innerHTML = '';
  const state = document.createElement('div');
  state.className = 'power-state';
  state.innerHTML = '<span class="power-lamp"></span><b></b>';
  main.appendChild(state);

  const row = document.createElement('div');
  row.className = 'btn-row';
  if (supports('system', 'setPowerStatus')) {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.dataset.role = 'power-toggle';
    // Read the state at click time: the label is repainted in place, so a
    // handler that captured it at build time would act on stale state.
    btn.onclick = () => {
      const on = powerState === 'active';
      guard(rpc('system', 'setPowerStatus', [{ status: !on }]),
        on ? 'Standby requested' : 'Wake requested');
    };
    row.appendChild(btn);
  }
  if (supports('system', 'requestReboot')) {
    const btn = document.createElement('button');
    btn.className = 'ghost-btn danger-ghost';
    btn.textContent = 'Reboot';
    btn.onclick = () => {
      if (confirm('Reboot the display now?')) guard(rpc('system', 'requestReboot', []), 'Reboot requested');
    };
    row.appendChild(btn);
  }
  main.appendChild(row);
}

/* Value-only update, safe to run while the user is focused in the card. */
function paintPowerState(main) {
  const on = powerState === 'active';
  const lamp = main.querySelector('.power-lamp');
  if (lamp) lamp.className = 'power-lamp ' + (on ? 'on' : 'standby');
  const label = main.querySelector('.power-state b');
  if (label) label.textContent = on ? 'Powered on' : 'Standby';
  const btn = main.querySelector('[data-role="power-toggle"]');
  if (btn) {
    btn.textContent = on ? 'Go to standby' : 'Wake display';
    btn.classList.toggle('warn', on);
    btn.title = on ? '' : 'Requires "Remote start" to be enabled on the TV';
  }
}

function fieldRow(label, control) {
  const row = document.createElement('div');
  row.className = 'field-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);
  row.appendChild(control);
  return row;
}

const POWER_SAVE_MODES = ['off', 'low', 'high', 'pictureOff'];
const LED_MODES = ['Demo', 'AutoBrightnessAdjust', 'Dark', 'SimpleResponse', 'Off'];

/* Fetched only from refreshSettingsCards (connect / wake / manual refresh /
   after an edit), never per poll tick. */
async function loadPowerExtras() {
  const my = epoch;
  const rows = [];
  if (supports('system', 'getPowerSavingMode') && supports('system', 'setPowerSavingMode')) {
    try {
      const mode = (await rpc('system', 'getPowerSavingMode', []))[0].mode;
      rows.push(fieldRow('power saving', makeSelect(POWER_SAVE_MODES, mode, v =>
        guard(rpc('system', 'setPowerSavingMode', [{ mode: v }]), 'Power saving: ' + v))));
    } catch { /* unavailable right now, row omitted */ }
  }
  if (supports('system', 'getLEDIndicatorStatus') && supports('system', 'setLEDIndicatorStatus')) {
    try {
      const led = (await rpc('system', 'getLEDIndicatorStatus', []))[0];
      rows.push(fieldRow('led indicator', makeSelect(LED_MODES, led.mode, v =>
        guard(rpc('system', 'setLEDIndicatorStatus', [{ mode: v, status: 'true' }]),
          'LED mode: ' + v))));
    } catch { /* unavailable right now, row omitted */ }
  }
  if (my !== epoch) return;
  const extras = $('power-extras');    // fresh lookup: never a detached node
  if (extras && !interacting(extras)) extras.replaceChildren(...rows);
}

function makeSelect(options, current, onChange) {
  const sel = document.createElement('select');
  const opts = options.includes(current) || current == null ? options : [current, ...options];
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    if (o === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => onChange(sel.value);
  return sel;
}

/* ── rendering: now playing ────────────────────────────────────────── */

function renderPlaying(info) {
  currentUri = info && info.uri ? info.uri : null;
  highlightActiveInput();
  const card = $('card-playing');
  if (!supports('avContent', 'getPlayingContentInfo')) { card.hidden = true; return; }
  card.hidden = false;
  const body = $('playing-body');
  $('playing-sub').textContent = 'avContent.getPlayingContentInfo';

  if (!info) {
    body.innerHTML = '<p class="play-meta">No playing-content details; the display is showing ' +
      'an app or the home screen.</p>';
    return;
  }
  body.innerHTML = '';
  const title = document.createElement('p');
  title.className = 'play-title';
  title.textContent = info.title || info.programTitle || '(untitled)';
  body.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'play-meta';
  meta.textContent = info.uri || info.source || '';
  body.appendChild(meta);

  if (info.programTitle && info.programTitle !== title.textContent) {
    const prog = document.createElement('p');
    prog.className = 'play-prog';
    prog.textContent = info.programTitle;
    body.appendChild(prog);
  }

  const facts = [];
  if (info.dispNum) facts.push(['channel', info.dispNum]);
  if (info.bivl_provider) facts.push(['provider', info.bivl_provider]);
  if (info.startDateTime) {
    const start = new Date(info.startDateTime);
    if (!isNaN(start)) {
      facts.push(['started', start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })]);
      if (info.durationSec) {
        const end = new Date(start.getTime() + info.durationSec * 1000);
        facts.push(['ends', end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })]);
        const pct = Math.min(100, Math.max(0, (Date.now() - start) / (info.durationSec * 10)));
        const bar = document.createElement('div');
        bar.className = 'progressbar';
        bar.innerHTML = '<div style="width:' + pct.toFixed(1) + '%"></div>';
        body.appendChild(bar);
      }
    }
  }
  if (facts.length) {
    const kv = document.createElement('dl');
    kv.className = 'kv';
    kv.style.marginTop = '10px';
    for (const [k, v] of facts) kv.innerHTML += '<dt>' + k + '</dt><dd></dd>';
    [...kv.querySelectorAll('dd')].forEach((dd, i) => dd.textContent = facts[i][1]);
    body.appendChild(kv);
  }
}

/* ── rendering: volume ─────────────────────────────────────────────── */

function renderVolume(targets) {
  const card = $('card-volume');
  if (!supports('audio', 'getVolumeInformation') || !targets) {
    if (!supports('audio', 'getVolumeInformation')) card.hidden = true;
    return;
  }
  card.hidden = false;
  $('volume-sub').textContent = 'audio.getVolumeInformation';
  const body = $('volume-body');

  // While the user is on any control in this card (slider mid-drag, +/− or
  // mute button focused), update values in place instead of rebuilding:
  // a rebuild would destroy the element they're interacting with.
  if (interacting(body)) {
    const rows = body.querySelectorAll('.vol-row');
    targets.forEach((t, i) => {
      const row = rows[i];
      if (!row) return;
      const val = row.querySelector('.vol-val');
      if (val) val.textContent = t.volume;
      const slider = row.querySelector('input[type="range"]');
      if (slider && document.activeElement !== slider) slider.value = t.volume;
      const mute = row.querySelector('.mute-btn');
      if (mute) {
        mute.classList.toggle('muted', !!t.mute);
        mute.textContent = t.mute ? 'muted' : 'mute';
      }
    });
    return;
  }

  body.innerHTML = '';
  const canSet = supports('audio', 'setAudioVolume');
  const canMute = supports('audio', 'setAudioMute');

  for (const t of targets) {
    const row = document.createElement('div');
    row.className = 'vol-row';

    const head = document.createElement('div');
    head.className = 'vol-head';
    head.innerHTML = '<span class="vol-target"></span>';
    head.querySelector('.vol-target').textContent = t.target || 'master';

    if (canMute) {
      const mute = document.createElement('button');
      mute.className = 'ghost-btn mute-btn' + (t.mute ? ' muted' : '');
      mute.textContent = t.mute ? 'muted' : 'mute';
      // Read the displayed state at click time, since soft updates may have
      // changed it since this row was built.
      mute.onclick = () => guard(rpc('audio', 'setAudioMute',
        [{ status: !mute.classList.contains('muted') }]));
      head.appendChild(mute);
    }
    const val = document.createElement('span');
    val.className = 'vol-val';
    val.textContent = t.volume;
    head.appendChild(val);
    row.appendChild(head);

    const ctl = document.createElement('div');
    ctl.className = 'vol-ctl';
    if (canSet) {
      const dn = document.createElement('button');
      dn.className = 'key-btn'; dn.textContent = '−';
      dn.title = 'Volume down';
      dn.onclick = () => guard(rpc('audio', 'setAudioVolume', [{ target: t.target, volume: '-1' }]));
      ctl.appendChild(dn);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = t.minVolume ?? 0;
      slider.max = t.maxVolume ?? 100;
      slider.value = t.volume;
      slider.oninput = () => { val.textContent = slider.value; };
      slider.onchange = () =>
        guard(rpc('audio', 'setAudioVolume', [{ target: t.target, volume: String(slider.value) }]));
      ctl.appendChild(slider);

      const up = document.createElement('button');
      up.className = 'key-btn'; up.textContent = '+';
      up.title = 'Volume up';
      up.onclick = () => guard(rpc('audio', 'setAudioVolume', [{ target: t.target, volume: '+1' }]));
      ctl.appendChild(up);
    }
    row.appendChild(ctl);
    body.appendChild(row);
  }
}

/* ── rendering: inputs ─────────────────────────────────────────────── */

let currentUri = null;

function highlightActiveInput() {
  for (const tile of document.querySelectorAll('.input-tile')) {
    tile.classList.toggle('active', !!currentUri && tile.dataset.uri === currentUri);
  }
}

function renderInputs(inputs) {
  const card = $('card-inputs');
  if (!supports('avContent', 'getCurrentExternalInputsStatus')) { card.hidden = true; return; }
  if (!inputs) return;
  card.hidden = false;
  $('inputs-sub').textContent = inputs.length + ' external inputs';

  const body = $('inputs-body');
  // Tiles are keyed by uri, so rebuild only when the set of inputs itself
  // changes; connection dots and labels are repainted in place every poll so
  // a tile the user just clicked (and still has focus) stays alive and current.
  const shape = inputs.map(i => i.uri || '').join('|');
  if (body.dataset.shape !== shape && !interacting(body)) {
    body.dataset.shape = shape;
    buildInputGrid(body, inputs);
  }
  paintInputs(body, inputs);
}

/* The TV hides an input's wiring in the uri query string, e.g.
   extInput:cec?type=freeuse&port=3&logicalAddr=5 */
function inputAddr(uri) {
  const params = new URLSearchParams(String(uri || '').split('?')[1] || '');
  const port = params.get('port');
  const logical = params.get('logicalAddr');
  if (port === null && logical === null) return null;
  const parts = [];
  if (port !== null) parts.push('port ' + port);
  if (logical !== null) parts.push('logical address ' + logical);
  // A missing half keeps its slot, so [3,] reads as "port 3, no logical addr".
  return { text: '[' + (port ?? '') + ',' + (logical ?? '') + ']', title: parts.join(', ') };
}

function isCecInput(uri) {
  return String(uri || '').split('?')[0].toLowerCase() === 'extinput:cec';
}

function buildInputGrid(body, inputs) {
  body.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'input-grid';
  const canSwitch = supports('avContent', 'setPlayContent');

  for (const inp of inputs) {
    const tile = document.createElement('button');
    tile.className = 'input-tile';
    tile.dataset.uri = inp.uri || '';
    const kind = (inp.icon || inp.uri || '').replace(/^meta:/, '').replace(/^extInput:/, '').split('?')[0];
    tile.innerHTML = '<span class="in-dot"></span>' +
      '<span class="in-top"><span class="in-kind"></span></span>' +
      '<span class="in-line"><span class="in-name"></span>' +
      '<span class="in-meta"></span></span>';
    tile.querySelector('.in-kind').textContent = kind;
    // Both of these come from the uri, which is what keys the rebuild, so they
    // are set once here rather than repainted every poll.
    if (isCecInput(inp.uri)) {
      const badge = document.createElement('span');
      badge.className = 'in-badge';
      badge.textContent = '⇄ CEC';
      badge.title = 'controllable over HDMI-CEC';
      tile.querySelector('.in-top').appendChild(badge);
    }
    const addr = inputAddr(inp.uri);
    const meta = tile.querySelector('.in-meta');
    if (addr) {
      meta.textContent = addr.text;
      meta.title = addr.title;
    } else {
      meta.remove();          // an empty span would still reserve its gap
    }
    if (canSwitch) {
      tile.onclick = () => guard(rpc('avContent', 'setPlayContent', [{ uri: inp.uri }]),
        'Switched to ' + (inp.label || inp.title || kind));
    } else {
      tile.disabled = true;
    }
    grid.appendChild(tile);
  }
  body.appendChild(grid);
}

/* Value-only update, safe while a tile holds focus. */
function paintInputs(body, inputs) {
  const byUri = new Map(inputs.map(i => [i.uri || '', i]));
  for (const tile of body.querySelectorAll('.input-tile')) {
    const inp = byUri.get(tile.dataset.uri);
    if (!inp) continue;
    const connected = String(inp.connection) === 'true';
    const dot = tile.querySelector('.in-dot');
    dot.classList.toggle('connected', connected);
    dot.title = connected ? 'device connected' : 'nothing connected';
    const kind = tile.querySelector('.in-kind').textContent;
    const name = tile.querySelector('.in-name');
    // The name is ellipsised to keep the address flush right, so hovering it
    // has to give back whatever got cut off.
    name.textContent = name.title = inp.label || inp.title || kind;
  }
  highlightActiveInput();
}

/* ── rendering: apps ───────────────────────────────────────────────── */

function renderApps() {
  const card = $('card-apps');
  const canLaunch = supports('appControl', 'setActiveApp');
  if (!apps.length || !supports('appControl', 'getApplicationList')) { card.hidden = true; return; }
  card.hidden = false;
  $('btn-terminate').hidden = !supports('appControl', 'terminateApps');

  const filter = $('app-filter').value.trim().toLowerCase();
  const body = $('apps-body');
  if (interacting(body)) return;   // filter input lives in the card header
  body.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'app-grid';

  for (const app of apps) {
    const title = app.title || '(untitled)';   // TVs may omit titles
    if (filter && !title.toLowerCase().includes(filter)) continue;
    const tile = document.createElement('button');
    tile.className = 'app-tile';
    tile.title = title;
    if (app.icon) {
      const img = document.createElement('img');
      img.src = app.icon;
      img.loading = 'lazy';
      img.alt = '';
      img.onerror = () => img.remove();
      tile.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = title;
    tile.appendChild(label);
    if (canLaunch) {
      tile.onclick = () => guard(rpc('appControl', 'setActiveApp', [{ uri: app.uri }]),
        'Launching ' + title);
    } else {
      tile.disabled = true;
    }
    grid.appendChild(tile);
  }
  body.appendChild(grid);
}

/* ── rendering: remote keys ────────────────────────────────────────── */

const KEY_GROUPS = [
  ['Navigation', ['Up', 'Down', 'Left', 'Right', 'Confirm', 'Return', 'Home', 'Options', 'Exit']],
  ['Playback', ['Play', 'Pause', 'Stop', 'Rewind', 'Forward', 'Prev', 'Next', 'Rec']],
  ['Channels', ['ChannelUp', 'ChannelDown', 'GGuide', 'Guide', 'Tv', 'Analog', 'Digital']],
  ['Numbers', ['Num0', 'Num1', 'Num2', 'Num3', 'Num4', 'Num5', 'Num6', 'Num7', 'Num8', 'Num9', 'Num11', 'Num12', 'DOT']],
];

const KEY_LABELS = {
  Up: '▲', Down: '▼', Left: '◀', Right: '▶',
  Confirm: 'OK', Return: 'Back', ActionMenu: 'Action Menu',
  ChannelUp: 'CH +', ChannelDown: 'CH −',
  Play: '▶ Play', Pause: '⏸ Pause', Stop: '■ Stop',
  Rewind: '◀◀', Forward: '▶▶', Prev: '|◀', Next: '▶|',
  Num0: '0', Num1: '1', Num2: '2', Num3: '3', Num4: '4',
  Num5: '5', Num6: '6', Num7: '7', Num8: '8', Num9: '9',
};

function renderKeys() {
  const card = $('card-keys');
  if (!irccCodes.length) { card.hidden = true; return; }
  card.hidden = false;
  $('keys-sub').textContent = irccCodes.length + ' codes via IRCC-IP';

  const byName = new Map(irccCodes.map(c => [c.name, c.value]));
  const used = new Set();
  const body = $('keys-body');
  if (interacting(body)) return;
  body.innerHTML = '';

  for (const [group, names] of KEY_GROUPS) {
    const present = names.filter(n => byName.has(n));
    if (!present.length) continue;
    present.forEach(n => used.add(n));
    body.appendChild(makeKeyGroup(group, present, byName));
  }

  const rest = irccCodes.filter(c => !used.has(c.name)).map(c => c.name);
  if (rest.length) {
    const details = document.createElement('details');
    details.className = 'key-extra';
    details.innerHTML = '<summary>' + rest.length + ' more keys</summary>';
    details.appendChild(makeKeyGroup(null, rest.sort(), byName));
    body.appendChild(details);
  }
}

// Navigation is laid out as a d-pad: each arrow on the side it points to,
// OK in the middle, and the four other keys on the corners.
const DPAD_CELLS = [
  ['Options', 'Up', 'Exit'],
  ['Left', 'Confirm', 'Right'],
  ['Return', 'Down', 'Home'],
];
const DPAD_ROUND = new Set(['Up', 'Down', 'Left', 'Right', 'Confirm']);

function makeKeyBtn(name, byName) {
  const btn = document.createElement('button');
  btn.className = 'key-btn';
  btn.textContent = KEY_LABELS[name] || name.replace(/([a-z])([A-Z])/g, '$1 $2');
  btn.title = name;
  btn.onclick = () => guard(sendIrcc(byName.get(name)));
  return btn;
}

function makeKeyGroup(title, names, byName) {
  const grp = document.createElement('div');
  grp.className = 'key-group';
  if (title) {
    const h = document.createElement('h3');
    h.textContent = title;
    grp.appendChild(h);
  }

  // A cell is filled only when the TV reports that key, and anything the pad
  // has no slot for (Home, say) falls through to the plain wrap below it.
  let loose = names;
  if (title === 'Navigation') {
    const inPad = new Set(DPAD_CELLS.flat().filter(n => names.includes(n)));
    if (inPad.size) {
      const pad = document.createElement('div');
      pad.className = 'key-pad';
      for (const row of DPAD_CELLS) {
        for (const name of row) {
          if (!inPad.has(name)) {
            const gap = document.createElement('span');
            gap.className = 'key-pad-gap';
            pad.appendChild(gap);
            continue;
          }
          const btn = makeKeyBtn(name, byName);
          if (DPAD_ROUND.has(name)) btn.classList.add('key-btn-round');
          pad.appendChild(btn);
        }
      }
      grp.appendChild(pad);
      loose = names.filter(n => !inPad.has(n));
    }
  }

  if (loose.length) {
    const wrap = document.createElement('div');
    wrap.className = 'key-wrap';
    for (const name of loose) wrap.appendChild(makeKeyBtn(name, byName));
    grp.appendChild(wrap);
  }
  return grp;
}

/* ── rendering: text entry ─────────────────────────────────────────── */

function renderTextCard(statusList) {
  const card = $('card-text');
  if (interacting(card)) return;   // never yank the field mid-typing
  if (!supports('appControl', 'setTextForm') || !statusList) { card.hidden = true; return; }
  const textInput = statusList.find(s => s.name === 'textInput');
  card.hidden = !(textInput && textInput.status === 'on');
}

/* ── rendering: generic settings (picture / sound / speaker) ───────── */

async function loadGenericSettings(service, getter, setter, cardId, bodyId) {
  const my = epoch;
  const card = $(cardId);
  if (!supports(service, getter)) { card.hidden = true; return; }
  let items;
  try {
    items = (await rpc(service, getter, [{ target: '' }]))[0];
  } catch (e) {
    // Hide only when the TV says the method doesn't exist; on a transient
    // failure keep whatever the card last showed instead of vanishing.
    if (!supports(service, getter)) card.hidden = true;
    return;
  }
  if (my !== epoch) return;
  if (!items || !items.length) { card.hidden = true; return; }
  card.hidden = false;

  const body = $(bodyId);
  // Rows are keyed by target, so rebuild only when the set of settings the TV
  // reports changes; current values are repainted in place every refresh so a
  // control the user just used (and still has focus) stays alive and current.
  const shape = items.map(i => i.target || '').join('|');
  if (body.dataset.shape !== shape && !interacting(body)) {
    body.dataset.shape = shape;
    buildSettingRows(body, items, service, getter, setter, cardId, bodyId);
  }
  paintSettingRows(body, items);
}

function buildSettingRows(body, items, service, getter, setter, cardId, bodyId) {
  body.innerHTML = '';
  const canSet = supports(service, setter);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    row.dataset.target = item.target || '';
    const label = document.createElement('label');
    label.textContent = (item.target || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    row.appendChild(label);

    const cands = (item.candidate || []).filter(c => c.isAvailable !== false);
    const numeric = cands.length && cands[0].value == null && cands[0].max != null;
    // Re-fetch only this card after an edit: nudge() already refreshes the
    // fast-moving state, and refetching every settings card was ~10 RPCs.
    const apply = (value) => guard(
      rpc(service, setter, [{ settings: [{ target: item.target, value: String(value) }] }]),
      null).then(() => loadGenericSettings(service, getter, setter, cardId, bodyId));

    if (numeric) {
      const c = cands[0];
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = c.min; slider.max = c.max; slider.step = c.step || 1;
      slider.dataset.noSet = canSet ? '0' : '1';
      const num = document.createElement('span');
      num.className = 'setting-num';
      slider.oninput = () => { num.textContent = slider.value; };
      slider.onchange = () => apply(slider.value);
      row.appendChild(slider);
      row.appendChild(num);
    } else if (cands.length) {
      const sel = makeSelect(cands.map(c => c.value), item.currentValue, apply);
      sel.dataset.noSet = canSet ? '0' : '1';
      row.appendChild(sel);
    } else {
      const val = document.createElement('span');
      val.className = 'setting-num';
      row.appendChild(val);
    }
    body.appendChild(row);
  }
}

/* Value-only update; it never touches the control the user is currently on. */
function paintSettingRows(body, items) {
  const byTarget = new Map(items.map(i => [i.target || '', i]));
  for (const row of body.querySelectorAll('.setting-row')) {
    const item = byTarget.get(row.dataset.target);
    if (!item) continue;
    row.classList.toggle('unavailable', item.isAvailable === false);

    const slider = row.querySelector('input[type="range"]');
    const sel = row.querySelector('select');
    const num = row.querySelector('.setting-num');
    const ctl = slider || sel;
    if (ctl) ctl.disabled = ctl.dataset.noSet === '1' || item.isAvailable === false;

    if (document.activeElement === ctl) continue;   // mid-drag / mid-choice
    if (slider) {
      slider.value = Number(item.currentValue);
      if (num) num.textContent = item.currentValue;
    } else if (sel) {
      if (![...sel.options].some(o => o.value === item.currentValue)) {
        const opt = document.createElement('option');
        opt.value = item.currentValue; opt.textContent = item.currentValue;
        sel.insertBefore(opt, sel.firstChild);
      }
      sel.value = item.currentValue;
    } else if (num) {
      num.textContent = item.currentValue;
    }
  }
}

/* ── rendering: system card ────────────────────────────────────────── */

function renderSystem(info) {
  const card = $('card-system');
  if (!info) { card.hidden = true; return; }
  card.hidden = false;
  const kv = document.createElement('dl');
  kv.className = 'kv';
  const facts = [
    ['product', info.product], ['name', info.name], ['model', info.model],
    ['generation', info.generation], ['area', info.area], ['language', info.language],
    ['serial', info.serial], ['mac', info.macAddr],
  ].filter(([, v]) => v);
  for (const [k, v] of facts) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    kv.appendChild(dt); kv.appendChild(dd);
  }
  $('system-body').replaceChildren(kv);
}

/* ── collapsible cards ─────────────────────────────────────────────── */

const COLLAPSE_KEY = 'bravia-console-collapsed';

function loadCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch { return {}; }
}

function initCollapsibleCards() {
  const collapsedMap = loadCollapsed();
  for (const card of document.querySelectorAll('#cards .card')) {
    const head = card.querySelector('.card-head');
    const body = card.querySelector('.card-body');
    if (!head || !body) continue;

    const btn = document.createElement('button');
    btn.className = 'collapse-btn';
    btn.textContent = '▾';
    btn.setAttribute('aria-label', 'Collapse or expand this card');
    if (body.id) btn.setAttribute('aria-controls', body.id);
    head.appendChild(btn);

    const apply = (isCollapsed, persist) => {
      card.classList.toggle('collapsed', isCollapsed);
      btn.setAttribute('aria-expanded', String(!isCollapsed));
      btn.title = isCollapsed ? 'Expand' : 'Collapse';
      if (persist) {
        const map = loadCollapsed();
        if (isCollapsed) map[card.id] = true; else delete map[card.id];
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map));
      }
    };
    apply(!!collapsedMap[card.id], false);

    head.addEventListener('click', (e) => {
      // The whole header toggles, except the header's own working controls
      // (apps filter box, "Close all", …); those keep their normal job.
      const hit = e.target.closest('button, input, select, a');
      if (hit && hit !== btn) return;
      apply(!card.classList.contains('collapsed'), true);
    });
  }
}

/* ── settings dialog ───────────────────────────────────────────────── */

function openSettings(errorMsg) {
  const dlg = $('settings-dialog');
  $('cfg-host').value = cfg?.host || '';
  $('cfg-psk').value = cfg?.psk || '';
  $('cfg-interval').value = cfg?.interval || 5;
  $('btn-cfg-cancel').disabled = !cfg;
  $('proxy-hint').textContent = proxyDetected
    ? 'Bundled proxy detected; requests are routed through this page’s origin, so the address here is informational.'
    : $('proxy-hint').textContent;
  const err = $('settings-error');
  if (errorMsg) { err.textContent = errorMsg; err.hidden = false; }
  else err.hidden = true;
  if (!dlg.open) dlg.showModal();
}

function initSettingsDialog() {
  $('settings-form').addEventListener('submit', (e) => {
    const host = $('cfg-host').value.trim();
    const psk = $('cfg-psk').value;
    const interval = Math.max(1, parseInt($('cfg-interval').value, 10) || 5);
    if (!host && !proxyDetected) {
      e.preventDefault();
      const err = $('settings-error');
      err.textContent = 'Enter the display’s hostname or IP address (or serve the app via proxy.js).';
      err.hidden = false;
      return;
    }
    cfg = { host, psk, interval };
    saveCfg(cfg);
    connect();
  });
  $('btn-cfg-cancel').onclick = () => $('settings-dialog').close();
  $('btn-psk-toggle').onclick = () => {
    const inp = $('cfg-psk');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('btn-psk-toggle').textContent = inp.type === 'password' ? 'show' : 'hide';
  };
  // A dialog with no config yet must not be dismissible via Esc.
  $('settings-dialog').addEventListener('cancel', (e) => { if (!cfg) e.preventDefault(); });
}

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
  initSettingsDialog();
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
  cfg = loadCfg();
  if (cfg) {
    $('empty-state').hidden = true;
    connect();
  } else {
    openSettings();
  }
}

main();

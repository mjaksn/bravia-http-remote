'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, cards-status.

   The cards that report what the display is doing: power, what is playing,
   volume per output, and the inputs. All four repaint on every poll, so
   each separates building its controls from painting their values, and
   leaves alone whatever the user is currently touching.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

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

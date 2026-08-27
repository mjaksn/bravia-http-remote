'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, cards-apps.

   The cards you press: the app grid, every IRCC key the display advertises
   grouped by what it is for, and the text field that appears when the
   display says one is focused on screen.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

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

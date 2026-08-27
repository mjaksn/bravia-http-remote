'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, cards-settings.

   The cards built from whatever settings the display reports: picture,
   sound and speaker, rendered from their declared ranges and choices
   rather than from anything hardcoded here, plus the system card.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

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

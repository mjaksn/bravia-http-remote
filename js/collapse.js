'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, collapse.

   Collapsing a card, and remembering which ones are collapsed.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */

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

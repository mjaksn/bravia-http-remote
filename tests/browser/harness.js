'use strict';

/* Shared scaffolding for the browser suites.
 *
 * Each suite loads the real index.html in an iframe and drives it the way
 * a person would: setting field values and dispatching the events the page
 * listens for. Being same-origin, a suite can also read the app's own
 * variables through the frame, which is how claims about what is in memory
 * and what is in storage get checked rather than inferred.
 */

const out = [];
let failures = 0;

function ok(name, condition, detail) {
  if (condition) out.push('ok   ' + name);
  else { failures++; out.push('FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function fail(name, detail) { ok(name, false, detail); }

function report() {
  const text = (failures ? 'FAILED: ' + failures : 'PASSED') + '\n' + out.join('\n');
  document.getElementById('log').textContent = text;
  fetch('/result', { method: 'POST', body: text });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Polls until the condition holds. Everything here is asynchronous: the
   app derives keys, talks to the network and repaints on its own clock. */
async function waitFor(condition, label, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    try { if (condition()) return true; } catch (e) { /* frame mid-reload */ }
    if (Date.now() - started > timeoutMs) { fail('timed out waiting for ' + label); return false; }
    await sleep(50);
  }
}

/* A handle on the app under test. */
function app(iframe) {
  const win = () => iframe.contentWindow;
  return {
    win,
    $: (id) => win().document.getElementById(id),
    // Reaches the app's module-scope state; `let` bindings are not
    // properties of window, so they are only reachable by evaluating.
    read: (expression) => win().eval(expression),
    fire: (id, type) => win().document.getElementById(id)
      .dispatchEvent(new (win().Event)(type, { cancelable: true, bubbles: true })),
    load: (src) => { iframe.src = src; },
    // An element can exist before the script that gives it its listeners
    // has run, so readiness means the document finished loading, not that
    // the markup is there.
    loaded: () => { try { return win().document.readyState === 'complete'; } catch (e) { return false; } },
  };
}

/* An exception thrown inside the app, in a timer or a listener, is
   invisible to a suite that only looks at the DOM afterwards. Surface it
   so a failure says what went wrong rather than only what did not
   happen. */
function watchErrors(a) {
  a.win().addEventListener('error', (e) => out.push('    app error: ' + e.message));
  a.win().addEventListener('unhandledrejection', (e) => out.push('    app rejection: ' + e.reason));
}

function run(suite) {
  suite().then(report).catch((e) => {
    fail('suite threw', (e && e.stack) || String(e));
    report();
  });
}

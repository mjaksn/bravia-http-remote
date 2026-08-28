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
  // An iframe starts on the initial empty document, and that one is a
  // special case: the browser reuses its window for the first navigation
  // out of it, so a stamp put there would survive into the page under test
  // and never clear. It needs no stamp anyway, because a load out of it is
  // finished exactly when the document is no longer about:blank.
  const blank = () => { try { return win().location.href === 'about:blank'; } catch (e) { return false; } };
  // True once a document that is neither blank nor on its way out has
  // finished loading. Reads across a navigation throw, so all are guarded.
  const settled = () => {
    try {
      return win().location.href !== 'about:blank' &&
        win().__outgoing === undefined &&
        win().document.readyState === 'complete';
    } catch (e) { return false; }
  };
  return {
    win,
    $: (id) => win().document.getElementById(id),
    // Reaches the app's module-scope state; `let` bindings are not
    // properties of window, so they are only reachable by evaluating.
    read: (expression) => win().eval(expression),
    fire: (id, type) => win().document.getElementById(id)
      .dispatchEvent(new (win().Event)(type, { cancelable: true, bubbles: true })),
    // Changing an iframe's src does not take effect at once. The outgoing
    // document stays in place, and goes on answering every read here, until
    // the response for the new one arrives. A suite that asserts straight
    // after a load is therefore liable to be talking to the page it thought
    // it had just left, which is worse than it sounds: the checks pass, but
    // against the wrong document, and the same race loses whenever the
    // navigation happens to win it. That is a test that proves nothing on a
    // good day and fails on a bad one.
    //
    // So the outgoing document is stamped before the src changes, and the
    // load is not finished until a document without that stamp is up and
    // complete. A window that has never been navigated carries no stamp,
    // so the first load waits only for the document to arrive.
    load: async (src) => {
      if (!blank()) { try { win().__outgoing = true; } catch (e) { /* mid-navigation */ } }
      iframe.src = src;
      return waitFor(settled, 'the page at ' + src);
    },
    // The same wait, for the one navigation that is not a new URL. Putting
    // the same src back navigates nowhere, so a reload is the only way to
    // revisit a page, and it needs the stamp exactly as a load does.
    reload: async () => {
      try { win().__outgoing = true; } catch (e) { /* mid-navigation */ }
      win().location.reload();
      return waitFor(settled, 'the reloaded page');
    },
    // An element can exist before the script that gives it its listeners
    // has run, so readiness means the document finished loading, not that
    // the markup is there.
    loaded: settled,
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

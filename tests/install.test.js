'use strict';

/* The installer's card handling, driven as bash functions.
 *
 * scripts/install.sh needs root and a real machine to run end to end, so
 * what is checked here is the part that decides what a re-run keeps. The
 * functions are lifted out of the script itself and called directly, rather
 * than copied into this file, where a copy would go on passing after the
 * script it was copied from had changed.
 *
 * Two promises are under test, both of them ones the script makes in prose
 * and neither of them free.
 *
 * Its header says a run that is neither asked nor told keeps whatever the
 * last one settled. The unsealed path keeps its file and gets that for
 * nothing. A seal writes the file from scratch, so it has to carry the
 * choice over by hand, and a --non-interactive --lock re-run is exactly the
 * case with nobody there to be asked.
 *
 * And a run that fails must take nothing away. Sealing can fail after it has
 * started, on a missing key file or an iteration count the console would
 * refuse, and the file it would have replaced holds a wall panel's whole
 * card selection.
 *
 * Run: node tests/install.test.js
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'install.sh');

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('ok   ' + name); return; }
  failed++;
  console.log('FAIL ' + name + (detail ? '\n  ' + detail : ''));
}

function eq(name, got, want) {
  ok(name, got === want, 'got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want));
}

/* Whichever bash is on this machine. Both runner images have one, including
   the Windows one, where tests/lint.js already syntax-checks this same
   script with it. */
function haveBash() {
  try {
    execSync('bash -c "exit 0"', { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

if (!haveBash()) {
  console.log('no bash here, so the installer functions cannot be driven');
  process.exit(0);
}

/* The functions, taken out of the script by name: everything from the line
   that opens one to the closing brace in the first column, which is the
   shape every one of them has. */
/* Split on either ending. A Windows checkout has this file in CRLF, and a
   closing brace with a carriage return still stuck to it matches nothing. */
const SOURCE = fs.readFileSync(SCRIPT, 'utf8').split(/\r?\n/);

function lift(name) {
  const open = SOURCE.findIndex((line) => line.startsWith(name + '() {'));
  if (open === -1) throw new Error('install.sh has no function ' + name);
  // A one-liner closes on its own line; the rest close on a bare brace.
  if (SOURCE[open].trimEnd().endsWith('}')) return SOURCE[open];
  for (let i = open + 1; i < SOURCE.length; i++) {
    if (SOURCE[i] === '}') return SOURCE.slice(open, i + 1).join('\n');
  }
  throw new Error(name + ' in install.sh is never closed');
}

const PRELUDE = ['say', 'die', 'list_cards', 'card_names', 'check_hide',
                 'saved_cards', 'carry_over_cards', 'write_card_config',
                 'seal_to', 'join_hide', 'settle_cards'].map(lift).join('\n\n');

/* Outside the checkout on purpose: seal.py refuses to write anywhere under a
   directory holding a Dockerfile, and the repository root is one. */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bravia-install-'));
const cfg = path.join(work, 'deploy-config.js');

function run(body, extra) {
  const script = path.join(work, 'harness.sh');
  fs.writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SOURCE_DIR=' + JSON.stringify(ROOT),
    'CONFIG_FILE=' + JSON.stringify(cfg),
    extra || '',
    PRELUDE,
    body,
  ].join('\n'), 'utf8');
  return spawnSync('bash', [script], { encoding: 'utf8' });
}

function lastLine(text) {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1];
}

/* ── what a re-run keeps ────────────────────────────────────────────── */

let r = run([
  'write_card_config "$CONFIG_FILE" "apps,keys"',
  'saved_cards',
].join('\n'));
eq('saved_cards reads back what write_card_config wrote', lastLine(r.stdout), 'apps,keys');

r = run([
  'rm -f "$CONFIG_FILE"',
  'saved_cards',
  'echo "(end)"',
].join('\n'));
eq('saved_cards says nothing when there is no config at all', lastLine(r.stdout), '(end)');

/* The placeholder this project ships explains the setting by showing the
   same assignment, indented, inside its opening comment. A config copied
   from it and edited by hand must carry the list underneath, never the
   example. The real file is used here rather than a handwritten stand-in,
   so that rewording that comment cannot quietly slip past this. */
fs.copyFileSync(path.join(ROOT, 'deploy-config.js'), cfg);
r = run('saved_cards\necho "(end)"');
eq('the example inside the placeholder comment is not a card list',
   lastLine(r.stdout), '(end)');

r = run([
  'printf "%s\\n" "   window.BRAVIA_HIDDEN_CARDS = [\'apps\', \'keys\'];" > "$CONFIG_FILE"',
  'printf "%s\\n" "window.BRAVIA_HIDDEN_CARDS = [\'volume\'];" >> "$CONFIG_FILE"',
  'saved_cards',
].join('\n'));
eq('an indented example is passed over for the assignment that runs',
   lastLine(r.stdout), 'volume');

/* The same the other way round, which is the case taking the last match
   cannot get right on its own: the assignment that runs comes first and the
   example explaining it comes after. */
r = run([
  'printf "%s\\n" "window.BRAVIA_HIDDEN_CARDS = [\'volume\'];" > "$CONFIG_FILE"',
  'printf "%s\\n" "/* for example:" >> "$CONFIG_FILE"',
  'printf "%s\\n" "   window.BRAVIA_HIDDEN_CARDS = [\'apps\', \'keys\']; */" >> "$CONFIG_FILE"',
  'saved_cards',
].join('\n'));
eq('an example below the assignment is passed over too',
   lastLine(r.stdout), 'volume');

/* Two that both run is a hand-edit rather than anything this project
   writes, and the browser would keep the later one. So does this. */
r = run([
  'printf "%s\\n" "window.BRAVIA_HIDDEN_CARDS = [\'apps\'];" > "$CONFIG_FILE"',
  'printf "%s\\n" "window.BRAVIA_HIDDEN_CARDS = [\'volume\'];" >> "$CONFIG_FILE"',
  // Every line it prints, not just the last, since two of them is the
  // failure being ruled out here.
  'saved_cards | tr "\\n" "|"',
  'echo',
].join('\n'));
eq('two assignments that both run leave the later one',
   r.stdout.trim(), 'volume|');

/* The first thing Copilot found: a --lock run that nobody answered used to
   seal an empty list straight over a real one. */
r = run([
  'write_card_config "$CONFIG_FILE" "apps,keys"',
  'ASKED=0',
  'HIDE=""',
  'carry_over_cards',
  'echo "HIDE=$HIDE"',
].join('\n'));
eq('an unanswered run carries the earlier card list into the seal',
   lastLine(r.stdout), 'HIDE=apps,keys');

r = run([
  'write_card_config "$CONFIG_FILE" "apps,keys"',
  'ASKED=1',
  'HIDE="volume"',
  'carry_over_cards',
  'echo "HIDE=$HIDE"',
].join('\n'));
eq('a run that was asked keeps its own answer', lastLine(r.stdout), 'HIDE=volume');

r = run([
  'rm -f "$CONFIG_FILE"',
  'ASKED=0',
  'HIDE=""',
  'carry_over_cards',
  'echo "HIDE=$HIDE"',
].join('\n'));
eq('nothing to carry over leaves the list empty', lastLine(r.stdout), 'HIDE=');

/* A hand-edited file can name something that is not a card. Refused here
   rather than sealed, which is what check_hide is for. */
r = run([
  'write_card_config "$CONFIG_FILE" "apps"',
  'ASKED=0',
  'HIDE=""',
  'carry_over_cards',
].join('\n'), 'true');
const before = r.status;
r = run([
  'printf "%s\\n" "window.BRAVIA_DEPLOY_CONFIG = null;" > "$CONFIG_FILE"',
  'printf "%s\\n" "window.BRAVIA_HIDDEN_CARDS = [\'nonsense\'];" >> "$CONFIG_FILE"',
  'ASKED=0',
  'HIDE=""',
  'carry_over_cards',
].join('\n'));
ok('a saved name that is not a card is refused, not carried over',
   before === 0 && r.status !== 0 && /not a card/.test(r.stderr),
   'good run exited ' + before + ', bad run exited ' + r.status + '\n  ' + r.stderr);

/* ── telling "put them all back" apart from "say nothing" ───────────── */

/* Three states, not two. A run can name cards, name none, or not raise the
   subject; only the last keeps what it found. Before --hide was tracked
   apart from its value, naming none and saying nothing were one state, and
   clearing a list was reachable from the prompt alone. */
function settle(vars) {
  return run([
    'write_card_config "$CONFIG_FILE" "apps,keys"',
    'ASKED=0',
    'KEEPING=0',
    'INTERACTIVE=0',
    vars,
    'settle_cards',
    'echo "ASKED=$ASKED HIDE=$HIDE"',
  ].join('\n'));
}

eq('naming cards settles the list to those',
   lastLine(settle('HIDE="volume"\nHIDE_SET=1').stdout), 'ASKED=1 HIDE=volume');

eq("an empty --hide settles it to none, which is an answer",
   lastLine(settle('HIDE=""\nHIDE_SET=1').stdout), 'ASKED=1 HIDE=');

eq('a run that never raised it settles nothing',
   lastLine(settle('HIDE=""\nHIDE_SET=0').stdout), 'ASKED=0 HIDE=');

/* An empty piece contributes nothing rather than a trailing comma, which
   check_hide would otherwise read as a card with no name at all. */
r = run('echo "[$(join_hide "apps" "")]"\necho "[$(join_hide "" "apps")]"\n' +
        'echo "[$(join_hide "apps" "keys")]"\necho "[$(join_hide "" "")]"');
eq('join_hide leaves no trailing comma behind an empty piece',
   r.stdout.trim().split('\n').join(' '), '[apps] [apps] [apps,keys] []');

/* ── what a failed seal leaves behind ───────────────────────────────── */

/* The interpreter's own path, found through a shell, because on Windows the
   name on PATH is often a .bat shim that CreateProcess will not launch. */
function python() {
  for (const name of ['python3', 'python']) {
    try {
      const found = execSync(name + ' -c "import sys; print(sys.executable)"',
                             { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (found && fs.existsSync(found)) return found;
    } catch { /* try the next one */ }
  }
  return null;
}

const PY = python();
if (!PY) {
  console.log('no python here, so seal_to is not driven');
} else {
  const pskFile = path.join(work, 'psk');
  const pwFile = path.join(work, 'pw');
  fs.writeFileSync(pskFile, '1234', 'utf8');
  fs.writeFileSync(pwFile, 'a-password', 'utf8');

  /* Seals over a card list that is already there, then reports whether that
     file changed and whether anything was left beside it. */
  function seal(args) {
    return run([
      'write_card_config "$CONFIG_FILE" "apps,keys"',
      'before="$(cat "$CONFIG_FILE")"',
      // In a subshell: seal_to reports a failure through die(), which exits,
      // and an exit would take the comparison below with it.
      '( seal_to "$CONFIG_FILE" ' + args + ' ) || true',
      'after="$(cat "$CONFIG_FILE")"',
      'if [ "$before" = "$after" ]; then echo UNCHANGED; else echo REPLACED; fi',
      'if [ -e "$CONFIG_FILE.new" ]; then echo LEFTOVER; else echo "no leftover"; fi',
    ].join('\n'), 'PYTHON=' + JSON.stringify(PY));
  }

  const good = '--host 192.0.2.10 --psk-file ' + JSON.stringify(pskFile) +
               ' --interval 5 --password-file ' + JSON.stringify(pwFile);

  r = seal(good);
  ok('a seal that works replaces the file', /REPLACED/.test(r.stdout), r.stdout + r.stderr);
  ok('and leaves nothing half-written beside it',
     /no leftover/.test(r.stdout), r.stdout + r.stderr);

  /* The second thing Copilot found: the old code deleted the config before
     anything that could fail had run. */
  r = seal('--host 192.0.2.10 --psk-file ' + JSON.stringify(path.join(work, 'no-such-psk')) +
           ' --interval 5 --password-file ' + JSON.stringify(pwFile));
  ok('a seal that fails on a missing key file changes nothing',
     /UNCHANGED/.test(r.stdout), r.stdout + r.stderr);
  ok('and clears up after itself', /no leftover/.test(r.stdout), r.stdout + r.stderr);

  r = seal(good + ' --iterations 99999999');
  ok('a seal refused for its iteration count changes nothing',
     /UNCHANGED/.test(r.stdout), r.stdout + r.stderr);
}

fs.rmSync(work, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

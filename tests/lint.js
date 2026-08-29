'use strict';

/* Checks that need no linter and no dependencies.
 *
 *   node tests/lint.js
 *
 * Four things, each of which has gone wrong somewhere before: a script
 * that does not parse, whether JavaScript, shell or Python; a version that
 * agrees with itself in only one place; a real deployment config committed
 * by accident; and punctuation this project does not use.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const JS = ['app.js', 'lockbox.js', 'deploy-config.js',
            'scripts/build.js', 'tests/lint.js', 'tests/serve.js', 'tests/run-browser.js',
            'tests/lockbox.test.js', 'tests/seal.test.js'];

const PROSE = ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE',
               'index.html', 'pack.html', 'style.css', 'app.js', 'lockbox.js',
               'deploy-config.js', 'proxy.py', 'package.json',
               'scripts/build.js', '.github/workflows/ci.yml', '.github/workflows/release.yml',
               'tests/lint.js', 'tests/serve.js', 'tests/run-browser.js', 'tests/lockbox.test.js',
               'tests/browser/harness.js', 'tests/browser/sealed.html',
               'tests/browser/unsealed.html', 'tests/browser/authfail.html',
               'seal.py', 'scripts/install.sh', 'Dockerfile', '.dockerignore',
               'docker-compose.yml'];

// Files that are not JavaScript and so cannot be parse-checked above, but
// which a broken edit breaks just as thoroughly. Checked with whatever
// already has to be installed to run them.
const SHELL = ['scripts/install.sh'];
const PYTHON = ['seal.py', 'proxy.py'];

const problems = [];
const note = (msg) => problems.push(msg);

/* ── every script parses ───────────────────────────────────────────── */

for (const file of JS) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
  if (r.status !== 0) note(file + ' does not parse:\n' + (r.stderr || '').trim());
}

/* ── the version agrees with itself ────────────────────────────────── */

const pkgVersion = JSON.parse(read('package.json')).version;
const appMatch = read('app.js').match(/const APP_VERSION = '([^']+)'/);

if (!appMatch) {
  note('app.js has no APP_VERSION constant');
} else if (appMatch[1] !== pkgVersion) {
  note(`version disagreement: package.json ${pkgVersion}, app.js ${appMatch[1]}`);
}

/* The release workflow lifts this section out to become the release page,
   so a version with no section cannot be released. Catching it here means
   finding out on the pull request rather than after pushing a tag. */
if (!read('CHANGELOG.md').includes('## [' + pkgVersion + ']')) {
  note(`CHANGELOG.md has no "## [${pkgVersion}]" section for the current version`);
}

/* ── no real deployment config in the repository ───────────────────── */

if (!/window\.BRAVIA_DEPLOY_CONFIG = null;/.test(read('deploy-config.js'))) {
  note('deploy-config.js is not the placeholder: a sealed deployment config ' +
       'must not be committed, since it pins every clone to one display');
}

/* ── punctuation ───────────────────────────────────────────────────── */

/* Em dashes and double hyphens standing in for them are not used here.
   Long command line options, CSS custom properties and HTML comments all
   contain two hyphens legitimately, so only a doubled hyphen that reads
   as punctuation is reported: one with space on both sides, or one
   welded between two words. */
const PUNCTUATING_DOUBLE_HYPHEN = /(\s--\s)|(\w--\w)/;
// Named by codepoint so that this file passes its own check.
const EM_DASH = String.fromCharCode(0x2014);

for (const file of PROSE) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { note('missing file: ' + file); continue; }
  fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    if (line.includes(EM_DASH)) note(`${where} em dash: ${line.trim()}`);
    if (PUNCTUATING_DOUBLE_HYPHEN.test(line)) note(`${where} double hyphen: ${line.trim()}`);
  });
}

/* ── the files that are not JavaScript ──────────────────────────────── */

/* seal.py and install.sh are as load-bearing as anything here: one writes the
   sealed config and the other installs the lot. Neither can be parse-checked
   by the block above, so each is handed to the thing that runs it. Both
   runtimes are already required by this project, and a missing one is a broken
   environment rather than a reason to quietly check less. */
function syntaxCheck(files, describe) {
  for (const file of files) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) { note('missing file: ' + file); continue; }
    const { cmd, args } = describe(full);
    if (!cmd) { note(`${file}: no interpreter found to check it with`); continue; }
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    if (result.error) {
      note(`${file}: could not run ${cmd} to check it: ${result.error.message}`);
    } else if (result.status !== 0) {
      const output = (result.stderr || result.stdout || '').trim();
      note(`${file}: ${output.split(String.fromCharCode(10))[0]}`);
    }
  }
}

/* The interpreter's own path, found once through a shell and then used
   directly. On Windows the name on PATH is often a .bat shim, which
   CreateProcess will not launch, so spawning it by name fails on a machine
   that has Python installed perfectly well. */
function interpreter(names) {
  for (const name of names) {
    try {
      const found = execSync(name + ' -c "import sys; print(sys.executable)"',
                             { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (found && fs.existsSync(found)) return found;
    } catch { /* try the next one */ }
  }
  return null;
}

const PY = interpreter(['python3', 'python']);

syntaxCheck(SHELL, (full) => ({ cmd: 'bash', args: ['-n', full] }));
// compile() rather than -m py_compile, which would leave a __pycache__
// behind on every lint run.
syntaxCheck(PYTHON, (full) => ({
  cmd: PY,
  args: ['-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', full],
}));

/* ── report ────────────────────────────────────────────────────────── */

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`lint ok: ${JS.length} scripts parse, version ${pkgVersion} agrees in ` +
            'package.json, app.js and CHANGELOG.md, deploy-config.js is the placeholder, ' +
            `punctuation clean across ${PROSE.length} files, ` +
            `${SHELL.length + PYTHON.length} shell and python files parse`);

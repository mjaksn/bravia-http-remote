'use strict';

/* Builds the release archive: the files someone needs in order to run the
 * console, and nothing else. Tests, workflows and the repository's own
 * furniture stay behind.
 *
 *   node scripts/build.js [output-dir]        (default: dist)
 *
 * The zip is written here rather than shelled out to, because `zip` is not
 * on every machine this has to build on, and a dependency for something
 * this small would be worse than the eighty lines below. Entries carry a
 * fixed timestamp, so building the same tree twice gives the same bytes.
 *
 * The version comes from package.json, which tests/lint.js has already
 * checked against app.js and which the release workflow has checked
 * against the tag. One file list, used by both workflows, so continuous
 * integration and the release cannot ship different things.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

const FILES = [
  'index.html',
  'style.css',
  'app.js',
  'lockbox.js',
  'deploy-config.js',
  'pack.html',
  'proxy.py',
  'seal.py',
  'scripts/install.sh',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'content',
];

/* ── zip writing ───────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 2020-01-01 00:00:00 in the DOS encoding zip uses, so the archive does
// not change just because the clock did.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data, mode } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // A tiny file can deflate larger than it started; store it instead.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra field length
    locals.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    // Host 3 (Unix) in the high byte, and the format version in the low one.
    // Left as MS-DOS, unzip discards the permission bits below entirely and
    // every file arrives 0644 whatever this says.
    dir.writeUInt16LE((3 << 8) | 20, 4);   // version made by: unix
    dir.writeUInt16LE(20, 6);              // version needed
    dir.writeUInt16LE(0, 8);               // flags
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);              // extra
    dir.writeUInt16LE(0, 32);              // comment
    dir.writeUInt16LE(0, 34);              // disk number
    dir.writeUInt16LE(0, 36);              // internal attributes
    // External attributes: a regular file, with the mode the working tree
    // had. Shifted back into an unsigned range, since a bitwise shift in
    // JavaScript is signed and this value does not fit in 31 bits.
    dir.writeUInt32LE(((0o100000 | (mode || 0o644)) << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, end]);
}

/* ── the build ─────────────────────────────────────────────────────── */

function collect(rel, into) {
  const full = path.join(ROOT, rel);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(full).sort()) collect(path.posix.join(rel, child), into);
  } else {
    // A file that starts with a shebang is meant to be run, and ships 0755.
    // install.sh is why: the README's instruction is `sudo scripts/install.sh`
    // and a 0644 copy answers that with "Permission denied".
    //
    // Decided by the shebang rather than by the mode on disk, because the
    // mode on disk is not portable. Windows does not carry an executable bit
    // at all, and this repository has core.fileMode false, so an archive
    // built on a laptop would differ from one built in CI.
    const data = fs.readFileSync(full);
    const mode = data.subarray(0, 2).toString('latin1') === '#!' ? 0o755 : 0o644;
    into.push({ name: rel, data, mode });
  }
  return into;
}

function main() {
  const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const name = 'bravia-console-' + version;

  for (const f of FILES) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      console.error('missing from the working tree: ' + f);
      process.exit(1);
    }
  }

  /* A sealed config must never travel inside a release: it would hand
     every downloader one particular display, and an archive is not the
     place to distribute a pre-shared key. */
  const deployConfig = fs.readFileSync(path.join(ROOT, 'deploy-config.js'), 'utf8');
  if (!/window\.BRAVIA_DEPLOY_CONFIG = null;/.test(deployConfig)) {
    console.error('deploy-config.js is not the placeholder; refusing to build');
    process.exit(1);
  }
  /* The same file's other half, and the same reasoning one size down: a card
     list in here is one that every unpacked copy of the archive leaves out,
     and nobody unpacking it has any reason to look in this file for the card
     that went missing. Checked here as well as in tests/lint.js, because a
     local `npm run build` runs this and not that. */
  if (!/window\.BRAVIA_HIDDEN_CARDS = \[\];/.test(deployConfig)) {
    console.error('deploy-config.js names cards to leave out; refusing to build');
    process.exit(1);
  }

  const entries = [];
  for (const f of FILES) collect(f, entries);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const archive = zip(entries.map(e => ({ name: name + '/' + e.name, data: e.data, mode: e.mode })));
  const out = path.join(outDir, name + '.zip');
  fs.writeFileSync(out, archive);

  console.log(`${out}  (${entries.length} files, ${(archive.length / 1024).toFixed(0)} KiB)`);
}

main();

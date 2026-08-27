'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Bravia Console, version.

   The version, alone in its own file so that the one place tooling looks
   for it is obvious. tests/lint.js checks it against package.json, and
   the release workflow checks both against the tag.

   One of the classic scripts index.html loads in order. They share a
   single global scope by design: no build step, and no modules, because
   a module cannot be loaded from a file:// page and this app has to open
   straight off disk.
   ═══════════════════════════════════════════════════════════════════════ */
/* Kept equal to `version` in package.json, and to the tag a release is cut
   from. tests/lint.js fails a pull request where the two disagree, and the
   release workflow refuses a tag that disagrees with either. */
const APP_VERSION = '1.0.0';

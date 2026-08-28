# Working in this repository

Bravia Console is a single-page controller for Sony Bravia displays. It is vanilla
JavaScript with no framework, no build step and no runtime dependencies, and it has to
keep working when opened straight off disk as a `file://` page. Those are constraints,
not accidents.

## Shape of the project

| Path | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The console itself. |
| `lockbox.js` | Self-contained SHA-256 / HMAC / PBKDF2 used to seal a deployment config. |
| `pack.html` | Standalone page that writes `deploy-config.js`. |
| `deploy-config.js` | Placeholder in the repository. A real one is produced per deployment. |
| `proxy.js`, `proxy.py` | Optional same-origin proxy, one per runtime, kept behaviourally identical. |
| `tests/` | Node unit tests and browser suites. No test framework. |
| `scripts/build.js` | Builds the release archive, zip writer included. One file list, used by both workflows. |

## Rules that the tooling enforces

`node tests/lint.js` runs on every pull request and fails on any of these, so they are
worth knowing before rather than after:

- **The version lives in two places and must agree**: `version` in `package.json` and
  `APP_VERSION` in `app.js`. A release additionally requires the tag to match both, and
  `CHANGELOG.md` to have a `## [x.y.z]` section for it.
- **`deploy-config.js` stays the placeholder.** Committing a sealed one would pin every
  clone to one display and put a real pre-shared key in the history.
- **No em dashes and no double hyphens used as punctuation.** Long command line options,
  CSS custom properties and HTML comments are unaffected.
- **Every script parses.**

## Adding to it

- **No dependencies.** Not for the app, not for the tests, not for the tooling. If
  something seems to need one, it probably needs less code instead.
- **No build step.** What is in the repository is what runs in the browser.
- **WebCrypto is not available.** The app is served over plain `http://` on a LAN, which
  is not a secure context, so `crypto.subtle` is missing exactly where it would be used.
  `crypto.getRandomValues` is fine. This is why `lockbox.js` implements its own hashing.
- **Keep the two proxies in step.** A change to one belongs in the other, including its
  comments and its usage text.
- **Prose the program emits is documentation.** Toasts, banner text, dialog copy and
  command line output age the same way a README does, and a claim usually appears in more
  than one place.

## Tests

```bash
npm run lint          # parses, versions, placeholder, punctuation
npm run test:unit     # lockbox primitives against Node's crypto
npm run test:browser  # the real pages driven in headless Chrome
npm test              # all three
```

The browser suites need Chrome, Chromium or Edge; set `CHROME_PATH` if it is somewhere
unusual. They serve the app over HTTP and drive `index.html` inside an iframe, choosing a
deployment config per suite, so the working tree is never modified by a test run. Pass
`--root DIR` to `tests/run-browser.js` to run them against an unpacked release archive
instead of the working tree, which is what continuous integration does to prove the
artefact works.

## Two implementations of one format

`lockbox.js` and `seal.py` both implement the sealed deployment config, because
the browser needs one and an installer on a headless machine needs the other.
They must agree byte for byte, and a disagreement is silent: `seal.py` opens
what it just wrote before handing it over, and that check passes just as
happily when both halves are wrong together.

So neither marks its own homework. `tests/seal.test.js` has each seal and the
other open, in both directions, on every CI run and on both operating systems.
If you touch the format in one, the test is what tells you about the other.

Not every shared constant fails the same way, and the difference matters when
you change one. `MAGIC` and `MAC_LEN` are compared directly by `lockbox.js`, so
a disagreement there is refused outright. The salt length, the nonce length and
the iteration count travel inside the blob and are read back from it, so the
console opens those whatever they are.

`MAX_ITERATIONS` is the one that bites. `lockbox.js` refuses a blob claiming
more than two million rounds rather than hanging on it, so a config sealed above
that ceiling is one the console can never open, and `seal.py` opening its own
work would not notice. That is why `seal.py` mirrors the ceiling and rejects it
before writing anything.

## The container image

The image runs `proxy.py`. It would be smaller to serve the static files alone,
and it would be wrong: the reason to run this in a container is to reach it from
another device, which puts the page and the display on different origins, which
is the case a Bravia's missing CORS preflight breaks. Serving statically would
work on the machine that built it and fail everywhere it was useful.

**A sealed `deploy-config.js` must never enter the image.** The threat model in
the README accepts that anyone holding the sealed blob can attack it offline,
which is a fair trade for a file on your own network. A published image changes
the population to anyone who can pull it, permanently, because registry layers
outlive the file. Three things guard this and all three should stay:

- `seal.py` refuses to write into a directory holding a `Dockerfile`.
- CI checks the running container serves the placeholder.
- The release workflow refuses to publish if `deploy-config.js` is not the
  placeholder.

`BRAVIA_TV` has no default. A proxy pointed at nothing starts happily and fails
on every request, which is a slower way to learn the same thing.

## Releasing

1. Bump `version` in `package.json` and `APP_VERSION` in `app.js` to the same number.
2. Write the `## [x.y.z] - YYYY-MM-DD` section in `CHANGELOG.md`, with its link
   definition at the foot. It becomes the release notes verbatim.
3. Merge through a pull request. The `gate` check has to pass.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`. That tag is the only trigger.

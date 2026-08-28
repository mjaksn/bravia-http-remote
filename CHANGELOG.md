# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release workflow lifts the section matching a pushed tag out of this file and
publishes it as the release notes, so a version with no section here does not get a
release page.

## [1.1.0] - 2026-08-28

### Added

- **A container image**, published to `ghcr.io/mjaksn/bravia-http-remote` and
  `docker.io/mjaksn/bravia-http-remote` on every release, for `linux/amd64`,
  `linux/arm64` and `linux/arm/v7`. It runs `proxy.py` rather than serving the
  files alone, because reaching the console from a phone puts the page and the
  display on different origins, which is the case a Bravia's missing CORS
  preflight breaks. `docker-compose.yml` is a worked example. The image ships
  the placeholder `deploy-config.js` and never a sealed one: a sealed blob
  inside a published image can be pulled and attacked offline by anyone, and
  registry layers outlive any attempt to take it back. A sealed config is
  mounted at run time instead, and both the release workflow and CI check that
  the image is carrying the placeholder.
- **`seal.py`**, which writes a password-protected `deploy-config.js` from a
  shell, for an installer or a machine with no display. It is the same format
  `pack.html` produces and the console opens, implemented a second time against
  Python's standard library. `tests/seal.test.js` has each implementation open
  what the other sealed, in both directions, because a sealer that checks its
  own work passes just as happily with both halves wrong together. The password
  is asked for rather than taken as an argument, since an argument is visible in
  `ps`, and it refuses to write into a directory holding a Dockerfile.
- **`scripts/install.sh`**, which sets the console up as either a systemd
  service or a Docker container, and offers to seal a locked config on the way.
  Every answer has a flag, and `--non-interactive` fails rather than hanging
  when nobody is there to answer.
- **A remembered visit now says it is signing you in**, rather than showing a
  blank page while it works. Opening the sealed config takes 120,000
  rounds of PBKDF2 on the main thread, and the automatic path ran it with the
  empty state already hidden and no dialog up, so a phone showed several
  seconds of frozen nothing. The empty state now says so and is repainted before
  the work starts, the way the typed path has always announced itself. The
  message goes in the empty state rather than in the prompt deliberately: the
  prompt being open is how the rest of the app knows the attempt is over.
- **Stay signed in on this computer**, a checkbox on the password prompt of a
  locked deployment. Ticked, it saves the deployment password in that browser's
  localStorage, and later visits open themselves with nothing to type. A saved
  password that no longer works, or that has been tampered with, is discarded and
  the prompt comes up as it would on a first visit. Logging out deletes it. The
  box is off unless it is ticked, and what is saved is only lightly disguised:
  anyone at that browser can read the password back out.

## [1.0.0] - 2026-08-26

First tagged release. The console itself predates this changelog; what follows is
what it does as of this version rather than an account of how it got here.

### Added

- Status dashboard for a Sony Bravia display over the Bravia HTTP REST API:
  power, current input or channel, per-output volume, input switching, the app
  grid, every IRCC key the display advertises, on-screen text entry, and the
  picture, sound and speaker settings the display reports.
- Capability discovery through `guide.getSupportedApiInfo`, falling back to
  `getMethodTypes`, so controls the display does not support are hidden rather
  than left to fail.
- Optional bundled proxy in two flavors, `proxy.js` and `proxy.py`, for displays
  that refuse CORS preflights. The app detects it and adjusts.
- Password-protected deployment config: `pack.html` seals a display address and
  pre-shared key into `deploy-config.js`, and a copy carrying that file starts
  locked, asking for the password instead of the connection details. While
  locked, neither value is written to any store that survives a reload, and the
  key is held XORed under a mask minted per page load.
- Release automation: continuous integration across Node versions and operating
  systems, and a tagged release built from a proven artefact with notes taken
  from this file.

[1.1.0]: https://github.com/mjaksn/bravia-http-remote/releases/tag/v1.1.0
[1.0.0]: https://github.com/mjaksn/bravia-http-remote/releases/tag/v1.0.0

# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release workflow lifts the section matching a pushed tag out of this file and
publishes it as the release notes, so a version with no section here does not get a
release page.

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/mjaksn/bravia-http-remote/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mjaksn/bravia-http-remote/releases/tag/v1.0.0

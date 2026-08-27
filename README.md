# Bravia Console

A single-page vanilla JS web app for controlling a Sony Bravia TV / professional display over
your local network. It talks **directly to the TV** using the Bravia HTTP REST API
(JSON-RPC over plain HTTP, no encryption) and authenticates with the
**pre-shared key** (`X-Auth-PSK` header). No frameworks, no build step, no
dependencies, just static files you can open from disk.

![The console connected to an XBR-75X90CH: a dark multi-column dashboard whose
cards cover power (powered on, with standby and reboot), the current input
(HDMI 2), audio, seven external inputs with connected-device dots, an app
filter, remote keys grouped by navigation, playback, channels and numbers,
picture and sound settings as sliders and dropdowns, speaker routing, and
system details.](content/screenshot.png)

The UI is a status dashboard, not a picture of a remote: everything the TV reports
is visible at once, and every supported action is one click away.

## Features

- **Power**: on / standby / reboot, power-saving mode, LED indicator mode
- **On**: current input or channel, program title, start/end time with progress
- **Audio**: per-output volume sliders (speaker, headphone, …), mute, ±1 steps
- **Inputs**: one-click switching, live "device connected" indicators, active input highlight
- **Apps**: full app grid with icons, filter box, one-click launch, close-all
- **Remote keys**: every IRCC code the TV advertises, grouped by function (nothing skeuomorphic)
- **Text entry**: appears automatically when a text field is focused on the TV
- **Picture / Sound / Speaker settings**: rendered dynamically from what the TV reports,
  sliders for numeric ranges, dropdowns for enumerations
- **Capability discovery**: the app asks the TV what it supports
  (`guide.getSupportedApiInfo`, with `getMethodTypes` fallback) and **hides**
  unsupported controls. Anything that only fails at runtime is hidden the moment
  the TV reports "no such method". Controls that exist but are unavailable in
  standby are shown dimmed with an "unavailable in standby" tag.

- **Locked deployments**: ship the app with the address and key already in it,
  sealed under a password, so that a browser that has never been given the
  password cannot read either one. See
  [Deploying a locked copy](#deploying-a-locked-copy).

State is polled on a configurable interval; the settings dialog (first launch, or
the ⚙ button) asks for hostname/IP, pre-shared key, and refresh interval.

## TV-side setup (one time)

On the TV: **Settings → Network → Home Network Setup → IP Control**

1. **Authentication** → *Normal and Pre-Shared Key*
2. **Pre-Shared Key** → choose your key
3. **Remote start** → *On* (required if you want to wake the TV from standby;
   browsers cannot send Wake-on-LAN packets)

## Running the app

Whether you need the bundled proxy depends on your TV. Every request this app
makes carries the `X-Auth-PSK` header and a non-safelisted `Content-Type`, so the
browser preflights all of them. Some Bravia models and firmware answer those
preflights with permissive CORS headers, and the app then works straight from a
`file://` page with no setup at all. Others never answer them, and the browser
blocks every call. There is no middle ground: a TV that refuses preflights leaves
the whole dashboard empty rather than half working.

So try Option A first, and fall back to the proxy only if it fails.

### Option A: open index.html directly

Double-click `index.html`, then enter the TV's hostname and pre-shared key in
settings. Nothing else is needed, provided the TV answers preflight requests.

To find out before trying, no pre-shared key required:

```bash
curl -i -X OPTIONS http://192.168.1.50/sony/system -H "Origin: null" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: x-auth-psk,content-type"
```

The response has to come back 2xx with two things in it: an
`Access-Control-Allow-Origin` whose value matches the page's origin, and an
`Access-Control-Allow-Headers` covering `x-auth-psk` and `content-type`. A
`file://` page sends `Origin: null`, which is what the probe above imitates, so
either `null` or `*` satisfies it. Note that `null` is a literal match and not a
wildcard: it permits a `file://` page and nothing else. Some firmware instead
echoes back whatever `Origin` it was sent, which permits everything.

A missing header, a value that does not match, or an error status all mean the
browser will block the app's calls, so use Option C.

### Option B: any static file server

Serve the files from anywhere **over plain `http://`**, or put your own
reverse proxy in front of `/sony/*`.

Serving them changes the page's origin from `null` to `http://host:port`, so a TV
that allowed Option A will not necessarily allow this. Re-run the Option A probe
with the origin you will actually be serving from:

```bash
curl -i -X OPTIONS http://192.168.1.50/sony/system -H "Origin: http://localhost:8080" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: x-auth-psk,content-type"
```

Firmware that echoes the origin back answers with that same URL and will work.
Firmware that answers with a literal `null`, or with nothing, will not, and you
want Option C.

Do not serve the page over `https://`; the browser would then also block the
plain-HTTP calls to the TV as mixed content, independent of CORS.

### Option C: bundled proxy (fallback for TVs that will not do CORS)

Not every Bravia answers preflight requests. When yours does not, the proxy sits
in between and makes every request same-origin, so CORS never comes into it. It
also works regardless of what the TV's headers say, which makes it the reliable
choice if you would rather not think about any of the above. Two identical
flavors are included; use whichever runtime you have:

```bash
python proxy.py 192.168.1.50
```

```bash
node proxy.js 192.168.1.50
```

Then open <http://localhost:8585>. The app auto-detects the proxy; you can leave
the hostname field blank in settings. (Defaults: port 8585, bound to 127.0.0.1.
Passing `... 8585 0.0.0.0` exposes it to your LAN; anyone who can reach the port
can then control the TV.)

## Deploying a locked copy

Left alone, the app asks each browser for the hostname and the pre-shared key and
keeps them in that browser's localStorage. That is fine for your own machine and
wrong for a page you leave sitting on the LAN, where anyone who loads it inherits
control of the display.

A locked deployment ships the connection details inside the page instead,
encrypted with a password. The app starts at a password prompt; a wrong password
gets **access denied** and nothing else. Everything past that point is the normal
console.

1. Open `pack.html` (double-click it, same as the app itself).
2. Fill in the display's address, the pre-shared key, a starting refresh interval,
   and the password you intend to hand out.
3. Press **Seal**. The page encrypts the lot, opens it again to prove the file
   works, and offers it for download as `deploy-config.js`.
4. Put that file next to `index.html`, replacing the placeholder the repo ships,
   and deploy the folder however you were going to.

To go back to the ordinary behavior, delete `deploy-config.js` or set
`window.BRAVIA_DEPLOY_CONFIG` back to `null`. To change the address, the key or
the password, repack: there is nothing to edit by hand, and a forgotten password
cannot be recovered.

### What a locked copy does with the details

Once unlocked, the address and key live in memory for the life of the tab and
nowhere else: neither is written to localStorage, sessionStorage, cookies or
IndexedDB, so a reload puts the page back at the password prompt. What the page
does still remember between visits is the two things that are not secrets, the
refresh interval and which cards you collapsed. The settings dialog drops the
address and key fields, keeps the refresh interval, and gains a **Log out**
button that reloads the page. While it is held, the key is XORed under a mask
minted per page load and unmasked only for the moment a request needs it, so it
is not sitting in plain sight in a heap snapshot or a devtools scope view.

### What it protects against, and what it does not

The bar being cleared is *a machine on the LAN that has never been given the
password cannot get the display's address or key out of this page*. That much it
does.

It is not a security boundary beyond that, and it is not trying to be:

- Anyone who can load the page can take a copy of `deploy-config.js` and attack it
  offline, at whatever rate their hardware allows. The password is stretched with
  120,000 rounds of PBKDF2-HMAC-SHA256 and the payload is sealed with
  HMAC-SHA256, which buys time against a weak password rather than safety. Pick a
  password worth guessing at.
- On a machine where the right password has been entered, the decrypted values are
  in that page's memory and can be read by anyone at that keyboard. Browser caches,
  swap files and memory dumps are all outside the scope of this.
- The requests themselves are unchanged: the key still travels in a cleartext
  `X-Auth-PSK` header over plain HTTP once the page is unlocked.

The crypto lives in `lockbox.js` and is deliberately self-contained rather than
using WebCrypto: `crypto.subtle` exists only in a secure context, and this app is
served over plain `http://` on a LAN, exactly where it would be missing.

## Notes

- Without a deployment config, the pre-shared key is stored **unencrypted in the
  browser's localStorage**. In every mode it travels in cleartext HTTP headers on
  your LAN. That last part is inherent to the PSK variant of the Bravia API.
- Some firmware answers CORS preflights by reflecting back whatever `Origin` it
  was sent, together with `Access-Control-Allow-Credentials: true`. On such a TV
  any web page you visit can reach the API from your browser, so the pre-shared
  key is the only barrier and is worth making long and non-obvious. A couple of
  methods (`getPowerStatus`, `getRemoteControllerInfo`) are answered without any
  key at all; the rest return `403 Forbidden`.
- Chromium is moving toward prompting for permission before a page may reach
  local-network addresses. If a browser update ever starts blocking the direct
  connection, the proxy in Option C is the way back.
- Wake-from-standby uses `system.setPowerStatus`; it only works when the TV's
  network-standby ("Remote start") is enabled. Some models also power the API
  down in deep eco standby.
- Most state queries fail while the TV is in standby; the app expects that and
  simply dims those cards instead of surfacing errors.

## API surface used

`POST http://<tv>/sony/<service>` with JSON-RPC body and `X-Auth-PSK` header:

| Service      | Methods                                                                 |
|--------------|-------------------------------------------------------------------------|
| `guide`      | `getSupportedApiInfo`                                                    |
| `system`     | `getSystemInformation`, `getPowerStatus`, `setPowerStatus`, `requestReboot`, `getPowerSavingMode`, `setPowerSavingMode`, `getLEDIndicatorStatus`, `setLEDIndicatorStatus`, `getRemoteControllerInfo`, `getMethodTypes` |
| `audio`      | `getVolumeInformation`, `setAudioVolume`, `setAudioMute`, `getSoundSettings`, `setSoundSettings`, `getSpeakerSettings`, `setSpeakerSettings` |
| `avContent`  | `getPlayingContentInfo`, `getCurrentExternalInputsStatus`, `setPlayContent` |
| `appControl` | `getApplicationList`, `getApplicationStatusList`, `setActiveApp`, `terminateApps`, `setTextForm` |
| `video`      | `getPictureQualitySettings`, `setPictureQualitySettings`                 |
| `ircc` (SOAP)| `X_SendIRCC` for remote key codes                                        |

# ACOB Browser

The browser image runs Chromium with the ACOB extension preinstalled. Chromium
is headful inside an Xvfb virtual display so extension APIs, screenshots, and
recording behave like a normal graphical browser without requiring a physical
display. This is not a stealth browser and does not attempt fingerprint evasion,
CAPTCHA bypass, or anti-bot circumvention.

Chromium runs as a dedicated non-root user. Its inner process sandbox is
disabled because standard Docker blocks the nested namespace operations it
requires; the container remains the process isolation boundary. Do not expose
this local-only stack to untrusted networks or run untrusted browser workloads.

The root `compose.yaml` is the supported runtime. It persists the Chromium
profile in the stack-local `browser-data` volume and gives the bundled extension
an initial server URL of `http://acob-proxy`. The extension reads its bundled
`settings.json` only when its profile has no stored extension settings; later
image rebuilds do not overwrite profile settings.

The browser image consumes a built extension directory through Docker's named
`extension` build context. It does not install Node dependencies or compile the
extension. The root `make install` and `make up` workflows build
`extension/dist/` first and pass it to Compose. To use an existing build instead,
set `EXTENSION_PATH`:

```bash
make install PORT=58346 NAME=default EXTENSION_PATH=/path/to/extension
```

The directory must contain the built extension's `manifest.json`. A custom path
is used as-is; its build-time server URL must already target the intended stack.

On container startup, the entrypoint removes Chromium's stale singleton lock,
cookie, and socket from the persisted profile. These process-local artifacts
cannot survive a container replacement because its hostname changes.

## Browser-Based VNC

VNC is disabled by default. Enable the passwordless noVNC debugger when starting
the stack:

```bash
ACOB_VNC_ENABLED=true make up PORT=58346 NAME=default
```

Open `http://127.0.0.1:58346/vnc`. nginx serves noVNC's `vnc_lite.html` and
proxies its WebSocket to websockify inside the browser container. x11vnc listens
only inside that container, and no separate host port is published. Passwordless
VNC is intended solely for trusted local development; leave it disabled
otherwise.

## Verification

Build the extension, check the startup script, and build the image from this
directory:

```bash
ACOB_BASE_URL=http://acob-proxy npm --prefix ../extension run build
make check
make build
```

Pass `EXTENSION_PATH=/path/to/extension` to `make build` to package another
prebuilt extension directory.

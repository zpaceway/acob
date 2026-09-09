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

The root `compose.yaml` is the supported runtime. The Chromium profile in
`/data` is ephemeral: no volume is mounted there, so every container recreate
(`make install`, `make up --build` with a changed image, `make down` followed
by `make up`) starts from a fresh profile. A stale profile can therefore never
survive an upgrade and break the extension's service worker. The profile only
survives stop/start of the same container. The bundled extension gets
an initial server URL of `http://acob-proxy`. The extension reads its bundled
`settings.json` only when its profile has no stored extension settings, so
every fresh profile picks up the baked-in defaults. That bundled file is built
from the extension's defaults in `src/settings.defaults.ts`
(see `../extension/README.md`).

To override the baked-in defaults without rebuilding the image, set
`ACOB_EXTENSION_SETTINGS` to a JSON object when starting the stack:

```bash
ACOB_EXTENSION_SETTINGS='{"baseUrl":"http://acob-proxy","allowCleanup":true}' make up PORT=58346 NAME=default
```

The entrypoint validates the object with `jq` and merges it over the bundled
`settings.json` before launching Chromium, so a partial object is enough
(e.g. just `{"baseUrl": ...}`). Every fresh profile picks the merged result
up, so the override always takes effect on the next container recreate. An
invalid JSON object
fails container startup with a clear error.

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

## Accessing Host Ports and Other Docker Networks

The stack keeps its internal `acob` bridge network: the browser reaches the
extension's server URL at `http://acob-proxy` like any other container. To keep
`localhost` usable, Chromium launches with
`--host-resolver-rules="MAP localhost host.docker.internal"`, so navigating the
managed browser to `http://localhost:5173` reaches your host dev server with
the URL and origin intact. No per-port configuration is needed; every host port
(`:5173`, `:3000`, any other) works through `localhost`. `compose.yaml` maps
`host.docker.internal` to the host gateway as the remap target, so keep that
`extra_hosts` entry. Bind the dev server to `0.0.0.0` (e.g. Vite
`--host 0.0.0.0`), not `127.0.0.1`, otherwise the gateway address cannot reach
it. The `Host` header stays `localhost`, so no Vite `allowedHosts` change is
needed. Sibling containers with published ports work the same way, e.g.
`http://localhost:<published-port>`.

Limit: the remap covers the `localhost` hostname only. The literal
`http://127.0.0.1:<port>` bypasses DNS resolution and still reaches the browser
container itself, so use the `localhost` hostname. Navigating to
`http://host.docker.internal:<port>` directly keeps working as an escape hatch.

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

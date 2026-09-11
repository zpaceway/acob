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
per-setting `ACOB_EXTENSION_*` variables when starting the stack:

```bash
ACOB_EXTENSION_BASE_URL=http://acob-proxy ACOB_EXTENSION_ALLOW_CLEANUP=true make up ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
```

Each variable maps to one `settings.json` key (empty means unset):

| Setting key | Environment variable |
| --- | --- |
| `baseUrl` | `ACOB_EXTENSION_BASE_URL` |
| `allowCleanup` | `ACOB_EXTENSION_ALLOW_CLEANUP` |
| `instructionsPerPoll` | `ACOB_EXTENSION_INSTRUCTIONS_PER_POLL` |
| `maxConcurrentExecutions` | `ACOB_EXTENSION_MAX_CONCURRENT_EXECUTIONS` |
| `maxTabs` | `ACOB_EXTENSION_MAX_TABS` |
| `pollIntervalMs` | `ACOB_EXTENSION_POLL_INTERVAL_MS` |
| `tabLoadTimeoutMs` | `ACOB_EXTENSION_TAB_LOAD_TIMEOUT_MS` |
| `httpRequestTimeoutMs` | `ACOB_EXTENSION_HTTP_REQUEST_TIMEOUT_MS` |
| `javascriptTimeoutMs` | `ACOB_EXTENSION_JAVASCRIPT_TIMEOUT_MS` |
| `maxScreenshotSizeMiB` | `ACOB_EXTENSION_MAX_SCREENSHOT_SIZE_MIB` |
| `maxRecordingDurationSec` | `ACOB_EXTENSION_MAX_RECORDING_DURATION_SEC` |
| `maxRecordingSizeMiB` | `ACOB_EXTENSION_MAX_RECORDING_SIZE_MIB` |
| `consoleTimeoutSec` | `ACOB_EXTENSION_CONSOLE_TIMEOUT_SEC` |
| `consoleMaxSizeMiB` | `ACOB_EXTENSION_CONSOLE_MAX_SIZE_MIB` |
| `resultRetryAttempts` | `ACOB_EXTENSION_RESULT_RETRY_ATTEMPTS` |
| `resultRetryDelayMs` | `ACOB_EXTENSION_RESULT_RETRY_DELAY_MS` |
| `popupStatusDurationMs` | `ACOB_EXTENSION_POPUP_STATUS_DURATION_MS` |
| `debuggerProtocolVersion` | `ACOB_EXTENSION_DEBUGGER_PROTOCOL_VERSION` |

`ACOB_EXTENSION_SETTINGS` (JSON object, e.g.
`ACOB_EXTENSION_SETTINGS='{"baseUrl":"http://acob-proxy","allowCleanup":true}'`)
is still accepted and merged first; per-setting variables win over it.
The entrypoint validates booleans (`true`/`false`) and integers with `jq`
and merges bundled settings < JSON < per-setting variables before launching
Chromium, so a partial override is enough. Every fresh profile picks the
merged result up, so the override always takes effect on the next container
recreate. An invalid value fails container startup with a clear error.

Browser display and VNC are configured with the `ACOB_BROWSER_*` variables
(`ACOB_BROWSER_WIDTH`, `ACOB_BROWSER_HEIGHT`,
`ACOB_BROWSER_VNC_ENABLED`, `ACOB_BROWSER_DISPLAY` like `:99`).

The browser image consumes a built extension directory through Docker's named
`extension` build context. It does not install Node dependencies or compile the
extension. The root `make install` and `make up` workflows build
`extension/dist/` first and pass it to Compose. To use an existing build instead,
set `ACOB_EXTENSION_PATH`:

```bash
make install ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default ACOB_EXTENSION_PATH=/path/to/extension
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
ACOB_BROWSER_VNC_ENABLED=true make up ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
```

Open `http://127.0.0.1:58346/vnc`. nginx serves noVNC's full `vnc.html` client
(toolbar with settings, scaling, quality, clipboard, fullscreen) and
proxies its WebSocket to websockify inside the browser container. The
lightweight client remains available at
`http://127.0.0.1:58346/vnc/vnc_lite.html?autoconnect=true&resize=scale&path=vnc/websockify`.
x11vnc listens
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
ACOB_EXTENSION_BASE_URL=http://acob-proxy npm --prefix ../extension run build
make check
make build
```

Pass `ACOB_EXTENSION_PATH=/path/to/extension` to `make build` to package another
prebuilt extension directory.

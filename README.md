# ACOB

ACOB (Agent Controlled Browser) is a local-first browser-control system. A
Django API queues instructions, a Chromium extension executes them in the
user's browser, and asynchronous Python and MCP interfaces give agents an API
for tabs, clicks, keyboard input, screenshots, JavaScript, and extension
recovery.

The repository is organized as a component-owned monorepo. Each project keeps
its source, dependencies, tooling, and documentation in its own directory.

## Repository Layout

| Directory | Project |
| --- | --- |
| [`browser/`](browser/README.md) | Managed Chromium image with Xvfb and optional local VNC. |
| [`client/`](client/README.md) | Independently installable Python API client. |
| [`extension/`](extension/README.md) | Manifest V3 Chromium extension and TypeScript package. |
| [`mcp/`](mcp/README.md) | Standalone Model Context Protocol service. |
| [`srv/`](srv/README.md) | Django instruction API and instruction queue (Postgres in Compose, SQLite fallback for local dev). |
| [`proxy/`](proxy/README.md) | nginx image for single-port routing of API + MCP. |
| [`web/`](web/README.md) | Buildless static marketing website. |

Product direction, accepted non-goals, and future milestones are tracked in
[`PLAN.md`](PLAN.md).

There is no root dependency manifest. The root Makefile installs and manages
isolated stack instances; component-specific development commands remain owned
by each component and can be run with `make -C <directory>` or
`npm --prefix <directory>`.

## Local setup

The server requires Python 3.14 or newer and
[`uv`](https://docs.astral.sh/uv/). Install its dependencies, apply migrations,
and start Django (SQLite fallback, no external DB needed):

```bash
uv --directory srv sync
make -C srv dev
```

The server binds to `0.0.0.0:58347`. Override the address with Make
variables, for example
`make -C srv dev ACOB_SRV_HOST=0.0.0.0 ACOB_SRV_PORT=8000`. Use `make -C srv run`
to serve the ASGI application with Uvicorn. These settings are intended for
local development and do not provide API authentication or TLS; review
[SECURITY.md](SECURITY.md) before exposing ACOB to a network.

## Docker

The recommended installation builds and starts a managed Chromium browser plus
the API and MCP services behind the unified proxy:

```bash
make install ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
```

This uses context and Compose project `acob-58346-default` and starts an isolated
Compose project with its own network, `srv-data` (media) and `db-data`
(Postgres) volumes, and an ephemeral browser profile. The proxy publishes the API and MCP port on `127.0.0.1`. The browser
runs Chromium as a non-root process on an Xvfb virtual display and loads the
ACOB extension from its image automatically. The install target builds
`extension/dist/` with `http://acob-proxy` as its initial server URL and passes
that output into the browser image build.

To package an extension that is already built, pass its directory instead:

```bash
make install ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default ACOB_EXTENSION_PATH=/path/to/extension
```

A custom path is used as-is and must contain `manifest.json` with the intended
build-time settings. To override the managed browser's baked-in extension
defaults without rebuilding its image, set `ACOB_EXTENSION_SETTINGS` to a JSON
object when starting the stack;
see [`browser/README.md`](browser/README.md). Overrides only seed fresh
profiles.

`ACOB_APPLICATION_NAME` is required and distinguishes a user or work context. The installation
context is always `acob-<port>-<name>`:

```bash
make install ACOB_PROXY_PORT=61554 ACOB_APPLICATION_NAME=alexandro
```

This uses context and Compose project `acob-61554-alexandro`. `ACOB_APPLICATION_NAME` may contain
lowercase letters, digits, and internal hyphens, but cannot start or end with a
hyphen. Compose network, volume, container, and image resources use the project
prefix. The `install-opencode` and `install-claude` targets also use the context
as their default MCP registration name.

Each stack has one global instruction queue and one managed browser. Untargeted
instructions (no `bid`) may be claimed by any connected browser, so for
deterministic ownership run one extension per stack or target each instruction
with that browser's `bid` (see [API](#api)). Instead of sharing one stack,
install another complete stack on a distinct proxy port:

```bash
make install ACOB_PROXY_PORT=61001 ACOB_APPLICATION_NAME=secondary
```

That creates Compose project `acob-61001-secondary`, its isolated network,
volumes, and browser. Use the same `ACOB_PROXY_PORT` and `ACOB_APPLICATION_NAME` with root `make up`, `make
down`, `make purge`, `make logs`, and `make ps`. Distinct
installations still require distinct `ACOB_PROXY_PORT` values because only one process can
bind a host port. Names are labels for user or work contexts; they do not add
protocol routing beyond the per-browser `bid` target, and untargeted work
remains claimable by any browser on that stack. See `compose.yaml` for lower-level service details and
[`proxy/README.md`](proxy/README.md) for nginx routing details.

Pre-existing unnamed contexts are outside the supported root lifecycle. Manage
them manually with Compose or replace them with a named installation.

The root `compose.yaml` is the only Compose file. Build the extension before
starting the full stack directly:

```bash
ACOB_EXTENSION_BASE_URL=http://acob-proxy npm --prefix extension run build
docker compose -f compose.yaml up --build
```

To run it in the background and follow its logs:

```bash
docker compose -f compose.yaml up --build --detach
docker compose -f compose.yaml logs --follow acob-srv
```

Individual services can be selected from the root file (for example
`docker compose -f compose.yaml up --build acob-srv`) or run natively with
`make -C srv dev` / `make -C mcp run`.

Stop a root-managed stack with `make down ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default`, or remove
its volumes as well with `make purge ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default`. The proxy setup
binds
`127.0.0.1:58346` by default. Native development ports remain `58347` for the
API and `58348` for MCP.

Compose runs five services (`acob-db`, `acob-srv`, `acob-mcp`, `acob-proxy`,
`acob-browser`). `acob-db` is Postgres 17 with a project-scoped `db-data`
volume; `acob-srv` waits for it, runs migrations, collects static files, and
ensures a default admin. Media uploads persist in the project-scoped `srv-data`
volume. `down` preserves both volumes; `purge` removes them. SQLite
(`DATA_DIR/db.sqlite3`) remains only as a local-dev fallback when no Postgres
is configured — see [`database/README.md`](database/README.md) and
[`srv/README.md`](srv/README.md).

Django admin is enabled at `/admin/` (e.g. `http://127.0.0.1:58346/admin/`
through the proxy). Native `make -C srv dev` and the container entrypoint both
run `manage.py ensure_superuser` (idempotent; `ACOB_SRV_SUPERUSER_USERNAME` /
`ACOB_SRV_SUPERUSER_EMAIL` / `ACOB_SRV_SUPERUSER_PASSWORD`, defaulting to
`admin` / `admin@example.com` / `changeme` with a warning). Change it later
with `manage.py changepassword`. Static files are served by Django via
WhiteNoise from `STATIC_ROOT` (collected at image build and on container
start), so admin CSS works with no nginx change.

`DEBUG` comes from `ACOB_SRV_DEBUG` (default `true` for
native dev); Compose sets `ACOB_SRV_DEBUG=false`, and with `DEBUG=false` the server
refuses to boot without `ACOB_SRV_SECRET_KEY`.
`ALLOWED_HOSTS` (`ACOB_SRV_ALLOWED_HOSTS`, default `*`) and
`CSRF_TRUSTED_ORIGINS` are env-driven. Database selection is
`ACOB_SRV_DATABASE_URL` or
`ACOB_SRV_DB_HOST`/`ACOB_SRV_DB_NAME`/`ACOB_SRV_DB_USER`/`ACOB_SRV_DB_PASSWORD`/`ACOB_SRV_DB_PORT`
(Compose: host `acob-db`, port `5432`, credentials from `ACOB_DATABASE_PORTGRES_*`); with
neither, the server falls back to local SQLite.

## Browser

The Docker installation includes the browser. It uses graphical Chromium on a
virtual Xvfb display rather than Chromium's headless mode, which keeps extension
and media APIs available in an unattended container. It does not provide
stealth, fingerprint evasion, CAPTCHA bypass, or anti-bot behavior.

Passwordless browser-based VNC debugging is disabled by default. Enable it when
starting the stack:

```bash
ACOB_BROWSER_VNC_ENABLED=true make up ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
```

Open `http://127.0.0.1:58346/vnc` in a browser. nginx serves noVNC's full
client (settings, scaling, clipboard) and proxies its WebSocket over the existing stack port. See
[`browser/README.md`](browser/README.md).

Inside the managed browser, `http://localhost:<port>` reaches host dev servers
(e.g. `:5173`, `:3000`; bind the server to `0.0.0.0`). Chromium remaps the
`localhost` hostname to the host gateway while the stack keeps its internal
Docker network. See [`browser/README.md`](browser/README.md).

## Browser extension

Install the extension toolchain and create a production build:

```bash
npm --prefix extension ci
npm --prefix extension run build
```

For native extension development, load the built extension in Chromium 116 or
newer:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose `extension/dist/`.

The extension source is strict TypeScript under `extension/src/`. It polls the
single global queue at its configured stack endpoint, identifying itself with
its per-browser `bid` (32 lowercase hex, generated on install, stored in
`chrome.storage.local`, shown read-only in the popup with Copy/Rotate). Every
instruction request accepts an optional `bid` target; untargeted instructions
are claimable by any browser while targeted ones only run on the matching
browser, and every instruction response carries the target `bid` while pending
and the executor `bid` after completion. Terminal instruction responses persist
and repeated reads return the same envelope. Extension settings remain local
to the extension and are known and controlled through its popup; they are not
reported through a public API. See [`extension/README.md`](extension/README.md)
for architecture, settings, permissions, package exports, and manual
verification steps.

Run the extension checks independently:

```bash
npm --prefix extension run typecheck
npm --prefix extension test
npm --prefix extension run build
```

The extension is also a reusable typed package. Its generated entry point exports
`ACOBSettings` plus the configuration, instruction, result, and runtime-message
contracts from `extension/src/types.ts`:

```typescript
import {
  ACOBSettings,
  type Configuration,
  type InstructionRequest,
} from "@zpaceway/acob-extension";

const configuration: Configuration = ACOBSettings.normalizeConfiguration({
  baseUrl: "https://acob.example",
});
const request: InstructionRequest = { action: "list" };
```

`npm run build` emits JavaScript, source maps, declaration files, the compiled
Tailwind stylesheet, and extension assets into `extension/dist/`.

## Python client

From the repository root, install the independently packaged Python client with
Python 3.10 or newer:

```bash
python -m pip install ./client
```

It exports the asynchronous `ACOBClient`, which submits instructions, waits for
their persistent terminal responses without blocking the event loop, and returns
their browser results:

```python
import asyncio

from acob import ACOBClient


async def main() -> None:
    async with ACOBClient() as client:
        tabs = await client.list()
        tab = await client.navigate("https://example.com")
        await client.scroll(tab.tid, 500)
        title = await client.javascript(tab.tid, "document.title")
        screenshot = await client.screenshot(tab.tid, full_page=True)
        print(screenshot.url)


asyncio.run(main())
```

After rebuilding a natively loaded unpacked extension, request a reinstall so
Chromium reads the updated files from `extension/dist/`:

```python
reinstall_request = await client.reinstall()
print(reinstall_request.token)
```

The command does not go through a separate polling channel. While a reinstall
is pending the server claims no queue work and instead delivers a `reinstall`
command from `instructions/next/`. The extension stops active JavaScript
executions, reloads affected tabs, restarts itself, and acknowledges the
command from the new worker. Processing instructions interrupted by the
restart fail explicitly instead of remaining stuck indefinitely.

`ACOBClient()` defaults to the proxy at `http://127.0.0.1:58346`. Pass only
`endpoint="http://127.0.0.1:61001"` to target another local stack. Pass
`bid="<32 lowercase hex>"` to any action (or `submit`/`execute`/`execute_batch`)
to target one browser — copy it from the extension popup's read-only Browser ID
field; omit it for untargeted work and read the executor `bid` from the result.
Independent
actions can be launched together with `asyncio.gather()`. See
[`client/README.md`](client/README.md) for every action, parallel execution,
low-level queue access, timeout behavior, and error types.

## MCP

The standalone [`mcp/`](mcp/README.md) project uses the official `mcp` Python
SDK and talks to Django through `acob-client`. It has its own dependencies,
tests, process, and container, but is not an installable Python package.

The MCP adapter runs as a Streamable HTTP server at `/mcp`. Its ACOB API origin
comes from the `ACOB_MCP_ENDPOINT` environment variable. When running via the
unified proxy the API and MCP share one port (`58346`):

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58346/mcp"
    }
  }
}
```

Root `make install-opencode` and `make install-claude` targets register this
endpoint under the installation context name `acob-<port>-<name>` by default.
Both targets require `ACOB_APPLICATION_NAME`; `ACOB_MCP_NAME` can override the registration label.
The registration name selects no browser or queue; the endpoint's port selects
the stack.

Standalone without the proxy the MCP port is separate:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58348/mcp"
    }
  }
}
```

Run it as a separate service:

```bash
make -C mcp run
```

`ACOB_MCP_ENDPOINT` is required by the MCP process; `make -C mcp run` supplies the
native-development default `http://127.0.0.1:58347`.

The recommended Docker workflow is the root `compose.yaml`, which runs all
services together:

```bash
docker compose -f compose.yaml up --build
```

Its MCP image includes the adapter and `acob-client`. For standalone native
development, run `acob-srv` or another reachable ACOB API independently with
`make -C srv dev` and `make -C mcp run`.

MCP tools mirror the Python client's high-level methods: `api`, `list`, `navigate`,
`focus`, `close`, `reload`, `scroll`, `click`, `wait`, `keyboard`, `screenshot`,
`record`, `proxy`, `cleanup`, `console`, `javascript`, and `reinstall`.
Every browser tool except `api` and `reinstall` accepts an optional `bid`
(32 lowercase hex) to target one browser; responses carry the executor `bid`.
Structured results use SDK-generated output schemas. `screenshot` always
returns the public download URL served by the ACOB server itself; neither the
client nor the MCP server downloads the image, so the agent fetches the
capture itself when it needs the pixels. See
[`mcp/README.md`](mcp/README.md) for all environment, transport, Docker,
security, and verification details.

## Website

The standalone site in `web/` is static and is not served by Django. Preview it
without installing dependencies:

```bash
python -m http.server 8000 --directory web
```

Open `http://127.0.0.1:8000`. See [`web/README.md`](web/README.md) for its file
layout and deployment expectations.

## API

Call the MCP `api` tool (no arguments) or Python `await client.api()` to obtain
the API guide and documentation URLs without queueing browser work. Open
`/api/docs/` on your stack for Swagger UI with the Python client alongside
the API, or fetch `/api/openapi.json` for the OpenAPI 3.1 contract with the
same client reference. `GET /api/` returns structured documentation links and
the submit/poll/consume workflow.

Documentation uses the incoming request's scheme, host and port for links,
curl examples and Swagger's API server. It is generated per request, so it
works across named stacks and custom ports. `ACOB_SRV_PUBLIC_URL` only affects
capture URLs. Swagger's assets are bundled locally and its external validator
is disabled. “Try it out” executes real API requests; extension-only routes
are explicitly marked and must not be used by controllers.

Compose enables `ACOB_MCP_API_SAME_ORIGIN` for MCP because API and MCP share the
proxy origin. Standalone MCP leaves it disabled and returns documentation for
its configured `ACOB_MCP_ENDPOINT`, which may use a different port. Reconnect MCP
clients after installing an update to discover the `api` tool.

The stack exposes one flat REST surface:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/` | Request-aware API links and usage guide. |
| `GET` | `/api/docs/` | Locally hosted Swagger UI. |
| `GET` | `/api/openapi.json` | OpenAPI 3.1 schemas and operation documentation. |
| `POST` | `/api/instructions/` | Validate and enqueue one instruction (optional `bid` target). |
| `POST` | `/api/instructions/batch/` | Validate and enqueue one sequential batch (optional top-level `bid`). |
| `GET` | `/api/instructions/next/` | Claim pending work from the global queue (`?bid=` + `?limit=`). |
| `GET` | `/api/instructions/<id>/` | Read instruction status or terminal result (persistent; always includes `bid`). |
| `POST` | `/api/instructions/<id>/result/` | Complete claimed work (executor `bid` in body or `?bid=`). |
| `POST` | `/api/reinstall/` | Request a stack-global extension reinstall. |
| `POST` | `/api/reinstall/acknowledge/` | Acknowledge reinstall from the restarted extension. |
| `GET` | `/api/media/<filename>` | Download a hosted capture. |

Create an instruction with `POST /api/instructions/`:

```bash
curl -X POST "http://127.0.0.1:58347/api/instructions/" \
  -H 'Content-Type: application/json' \
  -d '{"action":"list"}'
```

Supported instructions:

```json
{"action":"list"}
{"action":"navigate","url":"https://example.com"}
{"action":"navigate","tid":123,"url":"https://example.com"}
{"action":"focus","tid":123}
{"action":"close","tid":123}
{"action":"reload","tid":123}
{"action":"scroll","tid":123,"y":500}
{"action":"click","tid":123,"selector":"button[type=submit]"}
{"action":"wait","tid":123,"selector":"button[type=submit]"}
{"action":"wait","tid":123,"selector":"button[type=submit]","timeout_ms":5000}
{"action":"keyboard","tid":123,"text":"ACOB"}
{"action":"keyboard","tid":123,"key":"Enter","modifiers":[]}
{"action":"screenshot","tid":123,"full_page":false}
{"action":"record","method":"start","tid":123}
{"action":"record","method":"stop","tid":123}
{"action":"proxy","method":"set","proxy":"http://127.0.0.1:8080"}
{"action":"proxy","method":"unset"}
{"action":"cleanup"}
{"action":"console","method":"start","tid":123}
{"action":"console","method":"capture","tid":123}
{"action":"console","method":"stop","tid":123}
{"action":"javascript","tid":123,"script":"document.title"}
```

Every instruction request accepts an optional `bid` field: 32 lowercase hex
(`uuid4().hex` without dashes, `^[0-9a-f]{32}$`). `batch` accepts it top-level
for the whole cascade. `bid` is the target while the instruction is pending and
the executor after it completes, and every instruction response always includes
`bid` (`null` when untargeted/unclaimed). Copy the value from the extension
popup's read-only Browser ID field (Rotate generates a new one):

```json
{"action":"list","bid":"0123456789abcdef0123456789abcdef"}
{"action":"click","tid":123,"selector":"button","bid":"0123456789abcdef0123456789abcdef"}
{"action":"batch","bid":"0123456789abcdef0123456789abcdef","actions":[{"action":"list"}]}
```

`list` returns each tab's `tid`, window ID, domain, URL, title, active state,
and focused state. `active` means selected within its window; `focused` is only
true when that tab is active and its window is focused. `navigate` requires a
non-empty `url`; it navigates the supplied `tid`, or creates an inactive
background tab when `tid` is omitted, waits for the page load event, and
returns the tab details. New-tab navigation fails when the browser already has
the maximum number of tabs configured in the extension. `focus` activates a tab
and focuses its browser window. `focus` and `close` require a `tid`.

`reload` requires a `tid`, reloads that tab, waits for its page load event, and
returns updated tab details. `scroll` requires a `tid` and finite numeric `y`;
it leaves browser focus unchanged and dispatches trusted wheel input at a
visible scrollable surface, with positive values moving down and negative values moving up. Its
result is `{ "scrolled": true, "y": ... }`.

`click` requires a positive `tid` and a non-empty CSS `selector`. The extension leaves browser focus unchanged, scrolls the selected element into view, and sends mouse movement, press, and release input at the center of its largest rendered content fragment. The browser performs normal coordinate hit-testing, so an overlay or another element visually above the selected element receives the click instead. The result includes the selector and click coordinates.

`wait` requires a positive `tid` and a non-empty CSS `selector`, with an
optional `timeout_ms` (integer 1-90000; omit it for the extension's
`waitTimeoutMs` default of 30000 ms). It polls for the selector to match an
element and returns `{ "waited": true, "selector": ... }`. The wait survives
navigations and reloads while polling — the browser may reload or navigate to
a different final page and the wait still completes when the selector appears
there. It fails fast when the tab is closed or the selector is invalid, and
times out with `Timed out waiting for selector: ...` when the deadline passes.
Prefer `wait` over arbitrary sleeps after navigation-triggering interactions.

`keyboard` requires a positive `tid` and exactly one of `text` or `key`. Text
input sends `Input.insertText` to the control that has page focus and reports
the requested character count; it does not verify editability or the resulting
value. Named keys are `ArrowDown`, `ArrowLeft`, `ArrowRight`, `ArrowUp`,
`Backspace`, `Delete`, `End`, `Enter`, `Escape`, `Home`, `PageDown`, `PageUp`,
`Space`, and `Tab`; a single-character key is also accepted. Key input can
include unique `alt`, `ctrl`, `meta`, and `shift` modifiers. The extension
leaves browser focus unchanged, so the target tab and intended page control
must already have focus.

`focus`, `scroll`, `click`, and `keyboard` share one browser-global input lane.
This prevents concurrent actions for different tabs from switching the active
tab between an input action's targeting and dispatch phases.
Use `focus` before input when needed, preferably in the same batch so the
dependency is explicit and ordered. Input against a hidden tab fails with a
hint to call `focus` or try `javascript` instead of reporting a browser event
that Chromium dropped.

`screenshot` requires a positive `tid` and captures the full page as PNG by default. Set `full_page` to `false` to capture only the visible viewport. The completed result contains the public download URL served by the ACOB server itself, not image data:

```json
{
  "url": "https://acob.example/api/media/screenshot-12-<id>.png",
  "content_type": "image/png",
  "full_page": false
}
```

The server stores the capture locally under its media root and serves the
bytes at `/api/media/<filename>`; the instruction result carries only that
URL. Clients and the MCP server relay the URL without downloading it; fetching
the image is left to the user or agent. Media reads do not delete files;
Compose persists them in the `srv-data` volume until it is purged. When
storing the capture fails, the instruction completes as failed with a clear
error. Encoded captures are limited to 30 MiB; larger captures complete as
failed instructions rather than being submitted.

`record` with `method: start` requires a positive `tid` and starts a video
recording of that tab. It completes almost immediately with `{started}`;
the recording continues in the background until `record` with `method: stop`
for the same `tid` or the extension's maximum recording duration (default
10 minutes) is reached. Only one recording per tab is allowed. Set
`full_page` to `true` to record the tab's whole scrollable content instead
of only the visible viewport:

```json
{
  "action": "record",
  "method": "start",
  "tid": 123,
  "full_page": false
}
```

```json
{
  "started": true
}
```

`record` with `method: stop` requires the `tid` of the recording tab
and delivers the finalized video through the same storage pipeline as
screenshots. Recordings are encoded as MP4 (H.264) when the browser's
`MediaRecorder` supports it, otherwise as WebM (VP9):

```json
{
  "url": "https://acob.example/api/media/recording-42-<id>.mp4",
  "content_type": "video/mp4",
  "duration": 600.0,
  "stopped_reason": "max_duration",
  "message": "Recording stopped because the maximum duration was reached"
}
```

`stopped_reason` is `"user"` when the stop call stopped an active recording and
`"max_duration"` when the recording reached the extension's limit first; a late
stop then delivers the maximum-duration video instead of failing.
Recordings are video-only, roughly 2-5 fps at about 1 Mbps (scaled up for
full-page frames), and work best when the tab's window is focused (an
unfocused or hidden tab can fail the first capture with a focus hint). The
extension holds one shared debugger session per tab, so other actions — `click`,
`keyboard`, `screenshot`, `scroll`, and `javascript` — keep working on the
recording tab while it records. Recordings do not survive extension reloads,
and each stop delivers its video once.

`proxy` sets or unsets the browser-wide egress proxy so traffic is protected.
It takes a `method` (`set` or `unset`); `set` also requires a `proxy` string
(`http://host:port`, `https://host:port`, or `socks5://host:port`, with
optional `user:pass@` auth), while `unset` takes no proxy field and restores
the system proxy:

```json
{"action":"proxy","method":"set","proxy":"socks5://127.0.0.1:1080"}
{"action":"proxy","method":"unset"}
```

```json
{"proxied": true, "scheme": "socks5", "host": "127.0.0.1", "port": 1080, "authenticated": false}
```

```json
{"proxied": false}
```

The proxy is global to the whole browser profile, not per-tab: setting it
affects every tab and window. Results never echo credentials (`authenticated`
is boolean-only). Quiesce other work around proxy changes and verify with a
navigation afterwards.

`cleanup` clears all browser data except the ACOB extension itself, for use
when repeated navigation hits Cloudflare or other walls and the site becomes
operational again only after a full wipe. It takes no payload fields:

```json
{"action":"cleanup"}
```

```json
{"cleaned": true}
```

Authorization lives in the browser, not in the request: the extension only
accepts the instruction when its "Allow browser cleanup" setting is checked
in the extension popup (off by default). Remote callers cannot enable it;
when it is off the instruction fails with a hint to enable it. Confirm the
local `allowCleanup` setting in the popup before calling.

It clears cookies, localStorage (and sessionStorage), history, cache and
CacheStorage, downloads list, fileSystems, formData/autofill, IndexedDB, and
service workers across the whole profile (`since: 0`, `unprotectedWeb` and
`protectedWeb`, never extension origins, so extension settings in
`chrome.storage` are retained). Saved passwords are not cleared (Chrome
provides no extension API for them). It is browser-global and destructive:
all logins die, quiesce recordings and other work first (cleanup fails while
a recording is active), and open pages keep in-memory state until reloaded.

`console` captures the page's console output per tab. `method: start`
installs a shim that calls through to the real `console.debug/log/info/warn/error`
and buffers serialized entries in the page; `method: capture` returns a
cumulative snapshot without stopping; `method: stop` ends the session,
restores the original console methods, and delivers the final snapshot.
Only one session per tab is allowed. Snapshots go through the same storage
pipeline as screenshots, so the full log arrives as a download URL instead
of filling the agent's context:

```json
{"action":"console","method":"capture","tid":123}
```

```json
{
  "url": "https://acob.example/api/media/console-123-<id>.json",
  "content_type": "application/json",
  "entries": 42,
  "size_bytes": 4096,
  "truncated": false
}
```

The downloaded document is a JSON array of `{t, level, text}` entries.
Collection stops automatically at the `consoleTimeoutSec` deadline (default
180 s, at most 300 s) or when the buffer reaches `consoleMaxSizeMiB`
(default 2 MiB, at most 10 MiB); both are extension-local settings visible to
the user in the popup. A snapshot then carries `truncated: true`. The buffer lives in
the page, so navigation wipes it (a later capture fails with a "lost" hint
and the session is dropped) and only entries logged after `start` are kept.

`javascript` requires a `tid` and evaluates the supplied script in that tab.
Values available by value are returned as JSON-compatible results; Chromium
unserializable values are returned as strings or `{ "type", "description" }`
objects. The extension uses Chromium's debugger permission so execution is not
blocked by the page's content security policy. Before each script, it installs
bundled jQuery and Turndown under the frozen `window.__acob__` namespace, with
compatibility aliases at `window.$`, `window.jQuery`, and
`window.TurndownService`. Agents can select and reduce page content or return
compact Markdown without loading page or CDN scripts.

The configured JavaScript timeout is enforced by the extension, not by the
submitted script. The extension terminates Chromium execution and reloads the
affected tab before reporting a failed instruction, stopping asynchronous work
in the discarded page context without changing normal JavaScript evaluation
semantics. Unit tests cover timeout cleanup; Chromium execution termination and
tab responsiveness require manual extension verification.

To navigate an existing tab:

```json
{
  "action": "navigate",
  "tid": 123,
  "url": "https://example.com"
}
```

For example, an input can be updated and notified with:

```json
{
  "action": "javascript",
  "tid": 123,
  "script": "(() => { const input = document.querySelector('#name'); input.value = 'ACOB'; input.dispatchEvent(new Event('input', { bubbles: true })); return input.value; })()"
}
```

A batch runs up to 20 complete instructions sequentially, one at a time, so a
cascade of dependent actions is claimed and executed with a single request.
Submit it to `POST /api/instructions/batch/`:

```json
{
  "action": "batch",
  "actions": [
    {"action": "list"},
    {"action": "focus", "tid": 123},
    {"action": "click", "tid": 123, "selector": "input[name=query]"},
    {"action": "keyboard", "tid": 123, "text": "ACOB"},
    {"action": "screenshot", "tid": 123, "full_page": false}
  ]
}
```

The extension executes the actions strictly in order (each action still
respects the per-tab ordering shared with concurrently running instructions)
and completes the single batch instruction with one entry per action, in
order. Each entry carries either a `result` or an `error`; a failed action
does not stop the rest of the batch. Screenshot and recording entries go
through the same base64 storage pipeline as standalone actions, so screenshot
entries contain the served download URL in their final result:

```json
[
  {"result": [{"tid": 123, "window_id": 1, "active": true, "focused": true, "title": "Example", "url": "https://example.com/", "domain": "example.com"}]},
  {"result": {"tid": 123, "window_id": 1, "active": true, "title": "Example", "url": "https://example.com/", "domain": "example.com"}},
  {"result": {"clicked": true, "selector": "input[name=query]", "x": 240.0, "y": 18.0}},
  {"result": {"inserted_characters": 4}},
  {"result": {"url": "https://acob.example/api/media/screenshot-123-<id>.png", "content_type": "image/png", "full_page": false}},
  {"error": "No element matches selector: button"}
]
```

The batch instruction itself is claimed and completed like any other
instruction, so actions submitted outside a batch still run in parallel with
each other. Recordings are keyed by tab, so a batch can start recordings on
different tabs; starting twice on the same tab fails the second entry.

Any polling extension claims queued work with
`GET /api/instructions/next/?bid=<bid>&limit=4`. `limit` is optional, defaults
to 1, and accepts values from 1 through 20; `bid` is the claimant's browser ID
(32 lowercase hex). A claimant with a `bid` receives untargeted instructions
plus ones targeted at it; a claimant without a `bid` receives only untargeted
work. A successful response is an array of up to `limit` instructions whose
status has been changed to `processing`; an empty queue returns `204 No
Content`. While a reinstall is pending, the response is a single `reinstall`
command instead of queued work. The extension sends its `bid` on every poll and
submits it in the result body (`bid` body field or `?bid=` query), so
untargeted completions record which browser executed them; a targeted
instruction keeps its target `bid`.

Use the ID returned when creating an instruction to retrieve its status and result:

```bash
curl "http://127.0.0.1:58347/api/instructions/1/"
```

Reads are always non-destructive. Terminal (`completed`/`failed`) instructions
persist: repeated detail requests return the same envelope. Only `pending`
instructions are claimable, so completed work is never re-gathered. The response
always includes `bid`: the target while pending, the executor after completion
(`null` when untargeted/unclaimed).

Invalid requests return an `Invalid request` error with a `details` list containing the field, message, and validation type for each problem.

The client and MCP `reinstall` operation requests an unpacked-extension reload
with `POST /api/reinstall/`. While such a reinstall is
pending, `instructions/next/` returns a `reinstall` command instead of
claiming queue work; the extension executes it and restarts itself.
`POST /api/reinstall/acknowledge/` from the restarted worker completes the
handshake. The initial POST is idempotent while one reinstall is pending and
returns `202` with its token. The `reload` instruction reloads one tab through
the instruction queue.

An extension completes claimed work with
`POST /api/instructions/<id>/result/`. Media remains available at
`/api/media/<filename>`.

ACOB's shipped architecture is local-only. It has no authentication or claim
leases, and one stack must not be used as a network or enterprise control plane
unchanged; per-browser `bid` targeting is a routing hint, not an identity or
authorization boundary, and untargeted work remains claimable by any connected
browser. Such use requires an adapted deployment and protocol with
authentication and authorization, explicit executor identity and affinity,
leases, secure transport, and appropriate auditing and policy controls.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, verification, and
pull request guidance. Report vulnerabilities privately according to
[SECURITY.md](SECURITY.md). Community participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

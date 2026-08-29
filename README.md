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
| [`client/`](client/README.md) | Independently installable Python API client. |
| [`extension/`](extension/README.md) | Manifest V3 Chromium extension and TypeScript package. |
| [`mcp/`](mcp/README.md) | Standalone Model Context Protocol service. |
| [`srv/`](srv/README.md) | Django instruction API and SQLite queue. |
| [`proxy/`](proxy/README.md) | Unified nginx proxy (single-port routing for API + MCP). |
| [`web/`](web/README.md) | Buildless static marketing website. |

Product direction, accepted non-goals, and future milestones are tracked in
[`PLAN.md`](PLAN.md).

There is no root dependency manifest or root task runner. Run commands from the
relevant component directory, or use tools such as `make -C <directory>` and
`npm --prefix <directory>` from the repository root.

## Local setup

The server requires Python 3.14 or newer and
[`uv`](https://docs.astral.sh/uv/). Install its dependencies, prepare SQLite,
and start Django:

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

The recommended way to run the full stack is the unified proxy, which
fronts both the API and MCP on a single port (`58346` → `/mcp/` for MCP,
`/` for the API):

```bash
docker compose -f proxy/compose.yaml up --build
```

The proxy builds `acob-srv` and `acob-mcp` and runs `nginx:alpine` on
`http://127.0.0.1:58346` with `client_max_body_size 1024M` and streaming
timeouts. See [`proxy/README.md`](proxy/README.md) for details.

To run only the API server:

```bash
docker compose -f srv/compose.yaml up --build
```

That service applies migrations through `make run` and exposes `58347` on
the `acob` bridge network (or via the proxy). To run it in the background
and follow its logs:

```bash
docker compose -f srv/compose.yaml up --build --detach
docker compose -f srv/compose.yaml logs --follow acob-srv
# or via the proxy stack:
docker compose -f proxy/compose.yaml logs --follow acob-srv
```

Stop and remove it with `docker compose -f proxy/compose.yaml down` (full
stack) or `docker compose -f srv/compose.yaml down`. The SQLite database
is stored inside the container, so its data is lost when the container is
removed or replaced. The proxy setup binds `127.0.0.1:58346` by default
(API alone binds `127.0.0.1:58347`); do not expose either on an untrusted
network without additional controls.

## Browser extension

Install the extension toolchain and create a production build:

```bash
npm --prefix extension ci
npm --prefix extension run build
```

With either server running, load the built extension in Chromium 116 or newer:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose the `extension/dist/` directory.
4. Open the ACOB extension popup and copy its automatically generated browser ID.

The extension source is strict TypeScript under `extension/src/`. Each
installation gets a dashless UUID browser ID. Instructions are stored and
claimed under that ID, allowing one server to control multiple independent
browsers. Rotating the ID moves the extension to a new instruction queue. See
[`extension/README.md`](extension/README.md) for its architecture, settings,
permissions, package exports, and manual verification steps.

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
their one-use terminal responses without blocking the event loop, and returns
their browser results:

```python
import asyncio

from acob import ACOBClient


async def main() -> None:
    async with ACOBClient("0123456789ab4def8123456789abcdef") as client:
        tabs = await client.list()
        tab = await client.navigate("https://example.com")
        await client.scroll(tab.tid, 500)
        title = await client.javascript(tab.tid, "document.title")
        screenshot = await client.screenshot(tab.tid, full_page=True)
        print(screenshot.url)


asyncio.run(main())
```

After rebuilding an unpacked extension, request a reinstall so Chromium reads
the updated files from `extension/dist/`:

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

Pass `endpoint="http://host:port"` to target a non-default server. Independent
actions can be launched together with `asyncio.gather()`. See
[`client/README.md`](client/README.md) for every action, parallel execution,
low-level queue access, timeout behavior, and error types.

## MCP

The standalone [`mcp/`](mcp/README.md) project uses the official `mcp` Python
SDK and talks to Django through `acob-client`. It has its own dependencies,
tests, process, and container, but is not an installable Python package.

The MCP adapter runs as a Streamable HTTP server. Each connection selects its
browser with the BID path segment. Nothing is configurable per connection: the
ACOB API origin always comes from the `ACOB_ENDPOINT` environment variable.
When running via the unified proxy the API and MCP share one port (`58346`):

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58346/mcp/0123456789ab4def8123456789abcdef"
    }
  }
}
```

Standalone without the proxy the MCP port is separate:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58348/mcp/0123456789ab4def8123456789abcdef"
    }
  }
}
```

Run it as a separate service:

```bash
make -C mcp run
```

`ACOB_ENDPOINT` is required and has no built-in default; `make -C mcp run`
supplies a development default of `http://127.0.0.1:58347`. The BID is routing
configuration and is not authentication.

The recommended Docker workflow is the unified proxy, which runs both
services together:

```bash
docker compose -f proxy/compose.yaml up --build
```

Its image includes the adapter and `acob-client`. For standalone Docker,
run `acob-srv` or another reachable ACOB API independently:

```bash
docker compose -f mcp/compose.yaml up --build
```

MCP tools mirror the Python client's high-level methods: `list`, `navigate`,
`focus`, `close`, `reload`, `scroll`, `click`, `keyboard`, `screenshot`,
`record_start`, `record_stop`, `settings`, `javascript`, and `reinstall`.
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

Set `BID` to the browser ID shown in the extension popup. Create an instruction with `POST /api/browsers/<bid>/instructions/`:

```bash
BID=0123456789ab4def8123456789abcdef
curl -X POST "http://127.0.0.1:58347/api/browsers/$BID/instructions/" \
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
{"action":"keyboard","tid":123,"text":"ACOB"}
{"action":"keyboard","tid":123,"key":"Enter","modifiers":[]}
{"action":"screenshot","tid":123,"full_page":false}
{"action":"record_start","tid":123}
{"action":"record_stop","recording_id":45}
{"action":"javascript","tid":123,"script":"document.title"}
```

`list` returns each tab's `tid`, window ID, domain, URL, title, active state,
and focused state. `active` means selected within its window; `focused` is only
true when that tab is active and its window is focused. `navigate` requires a
non-empty `url`; it navigates the supplied `tid`, or creates an inactive
background tab when `tid` is omitted, waits for the page load event, and
returns the tab details. New-tab navigation fails when the browser already has
the maximum number of tabs configured in the extension. Only `focus` activates
a tab within its own window. It never raises or focuses the window, so it
cannot steal focus from another application. `focus` and `close` require a
`tid`.

`reload` requires a `tid`, reloads that tab, waits for its page load event, and
returns updated tab details. `scroll` requires a `tid` and finite numeric `y`;
it scrolls vertically by that many CSS pixels, with positive values moving down
and negative values moving up. Its result is `{ "scrolled": true, "y": ... }`.

`click` requires a positive `tid` and a non-empty CSS `selector`. The extension leaves browser focus unchanged, scrolls the selected element into view, and sends mouse movement, press, and release input at the center of its rendered border box. The browser performs normal coordinate hit-testing, so an overlay or another element visually above the selected element receives the click instead. The result includes the selector and click coordinates.

`keyboard` requires a positive `tid` and exactly one of `text` or `key`. Text
input sends `Input.insertText` to the control that has page focus and reports
the requested character count; it does not verify editability or the resulting
value. Named keys are `ArrowDown`, `ArrowLeft`, `ArrowRight`, `ArrowUp`,
`Backspace`, `Delete`, `End`, `Enter`, `Escape`, `Home`, `PageDown`, `PageUp`,
`Space`, and `Tab`; a single-character key is also accepted. Key input can
include unique `alt`, `ctrl`, `meta`, and `shift` modifiers. The extension
leaves tab and window focus unchanged, so the agent must focus the intended page
control first, usually with `click`.

`screenshot` requires a positive `tid` and captures the visible viewport as PNG. Set `full_page` to `true` to capture beyond the viewport. The completed result contains the public download URL served by the ACOB server itself, not image data:

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
the image is left to the user or agent. The server controls the lifetime of
the URL, which dies with the media files when the server restarts. When
storing the capture fails, the instruction completes as failed with a clear
error. Encoded captures are limited to 30 MiB; larger captures complete as
failed instructions rather than being submitted.

`record_start` requires a positive `tid` and starts a video recording of that
tab. It completes almost immediately with a tracking ID; the recording
continues in the background until `record_stop` or the extension's maximum
recording duration (default 5 minutes) is reached. Set `full_page` to `true`
to record the tab's whole scrollable content instead of only the visible
viewport:

```json
{
  "action": "record_start",
  "tid": 123,
  "full_page": false
}
```

```json
{
  "recording_id": 45,
  "started": true
}
```

`record_stop` requires the positive `recording_id` returned by `record_start`
and delivers the finalized video through the same storage pipeline as
screenshots. Recordings are encoded as MP4 (H.264) when the browser's
`MediaRecorder` supports it, otherwise as WebM (VP9):

```json
{
  "url": "https://acob.example/api/media/recording-42-<id>.mp4",
  "content_type": "video/mp4",
  "duration": 300.0,
  "stopped_reason": "max_duration",
  "message": "Recording stopped because the maximum duration was reached"
}
```

`stopped_reason` is `"user"` when `record_stop` stopped an active recording and
`"max_duration"` when the recording reached the extension's limit first; a late
`record_stop` then delivers the maximum-duration video instead of failing.
Recordings are video-only, roughly 2-5 fps at about 1 Mbps (scaled up for
full-page frames), and work best when the tab's window is focused (an
unfocused or hidden tab can fail the first capture with a focus hint). The
extension holds one shared debugger session per tab, so other actions — `click`,
`keyboard`, `screenshot`, `scroll`, and `javascript` — keep working on the
recording tab while it records. Recordings do not survive extension reloads,
and each `record_stop` delivers its video once.

The browser's configured limits and other settings are not an instruction:
the extension reports them periodically to
`POST /api/browsers/<bid>/heartbeat/`, and agents read them with
`GET /api/browsers/<bid>/settings/` before acting:

```json
{
  "settings": {
    "pollIntervalMs": 1000,
    "maxRecordingDurationSec": 300,
    "maxRecordingSizeMiB": 512
  },
  "updated_at": "2026-08-12T00:00:00Z"
}
```

The settings endpoint returns 404 until the extension has reported at least
once.

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
Submit it to `POST /api/browsers/<bid>/instructions/batch/`:

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
each other. `record_start` inside a batch uses the batch instruction's ID as
the recording ID, so a batch can contain at most one `record_start`; two would
fail the second with a duplicate-ID error.

The extension claims queued work with `GET /api/browsers/<bid>/instructions/next/?limit=4`. `limit` is optional, defaults to 1, and accepts values from 1 through 20. A successful response is an array of up to `limit` instructions whose status has been changed to `processing`; an empty queue returns `204 No Content`. While a reinstall is pending, the response is a single `reinstall` command instead of queued work.

Use the ID returned when creating an instruction to retrieve its status and result:

```bash
curl "http://127.0.0.1:58347/api/browsers/$BID/instructions/1/"
```

Reads are non-destructive while the instruction is `pending` or `processing`. The first detail request after it becomes `completed` or `failed` returns the terminal response and deletes the instruction. Every later request for that ID returns 404. Capture the complete terminal response from the polling request; do not issue another request to fetch its result.

Invalid requests return an `Invalid request` error with a `details` list containing the field, message, and validation type for each problem.

The browser ID must be a lowercase dashless UUIDv4. API clients select a browser by using its ID in every instruction route.

The client and MCP `reinstall` operation requests an unpacked-extension reload
with `POST /api/browsers/<bid>/reinstall/`. While such a reinstall is
pending, `instructions/next/` returns a `reinstall` command instead of
claiming queue work; the extension executes it and restarts itself.
`POST reinstall/acknowledge/` from the restarted worker completes the
handshake. The initial POST is idempotent while one reinstall is pending and
returns `202` with its token. The `reload` instruction reloads one tab through
the instruction queue.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, verification, and
pull request guidance. Report vulnerabilities privately according to
[SECURITY.md](SECURITY.md). Community participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

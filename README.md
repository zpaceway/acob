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
| [`mcp/`](mcp/README.md) | Standalone Model Context Protocol adapter. |
| [`srv/`](srv/README.md) | Django instruction API and SQLite queue. |
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

The server listens on `http://127.0.0.1:58347`. Override the address with Make
variables, for example `make -C srv dev HOST=0.0.0.0 PORT=8000`. Use
`make -C srv run` to serve the ASGI application with Uvicorn. These settings are
intended for local development and do not provide API authentication or TLS;
review [SECURITY.md](SECURITY.md) before exposing ACOB to a network.

## Docker

Build the image and start the server with Docker Compose:

```bash
docker compose -f srv/compose.yaml up --build
```

The Compose service applies migrations through `make run` and publishes port
`58347` on the host. To run it in the background and follow its logs:

```bash
docker compose -f srv/compose.yaml up --build --detach
docker compose -f srv/compose.yaml logs --follow acob-srv
```

Stop and remove it with `docker compose -f srv/compose.yaml down`. The SQLite
database is stored inside the container, so its data is lost when the container
is removed or replaced. Compose publishes the port on all host interfaces by
default; do not run this configuration on an untrusted network.

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
        png = await client.screenshot(tab.tid, full_page=True)


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
tests, package, process, and container.

The MCP adapter runs as a Streamable HTTP server. Each connection selects its
browser with the BID path segment. The optional `endpoint` query parameter
overrides the default Docker-reachable Django API origin:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58349/mcp/0123456789ab4def8123456789abcdef"
    }
  }
}
```

Run it as a separate service:

```bash
uv --directory mcp run acob-mcp
```

The default endpoint is `http://host.docker.internal:58347`. Add
`?endpoint=http://127.0.0.1:58347` to target another API origin. The BID and
endpoint value are routing configuration and are not authentication.
The Compose workflow starts only the MCP adapter. Its image includes the adapter
and `acob-client`; run `acob-srv` or another reachable ACOB API independently:

```bash
docker compose -f mcp/compose.yaml up --build
```

MCP tools mirror the Python client's high-level methods: `list`, `navigate`,
`focus`, `close`, `reload`, `scroll`, `click`, `keyboard`, `screenshot`,
`javascript`, and `reinstall`. Structured results use SDK-generated output
schemas, while `screenshot` returns an MCP PNG image content block. See
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
{"action":"javascript","tid":123,"script":"document.title"}
```

`list` returns each tab's `tid`, window ID, domain, URL, title, active state,
and focused state. `active` means selected within its window; `focused` is only
true when that tab is active and its window is focused. `navigate` requires a
non-empty `url`; it navigates the supplied `tid`, or creates an inactive
background tab when `tid` is omitted, waits for the page load event, and
returns the tab details. New-tab navigation fails when the browser already has
the maximum number of tabs configured in the extension. Only `focus` activates
a tab and focuses its containing window. `focus` and `close` require a `tid`.

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

`screenshot` requires a positive `tid` and captures the visible viewport as PNG. Set `full_page` to `true` to capture beyond the viewport. The completed result contains a relative, browser-scoped `download_url`, not image data:

```json
{
  "download_url": "/api/browsers/<bid>/screenshots/7/",
  "content_type": "image/png",
  "full_page": false,
  "single_use": true,
  "tid": 123
}
```

The screenshot is stored base64-encoded in SQLite until the first `GET` to that URL. That request returns the decoded PNG and deletes the screenshot row. A second request returns 404, and an interrupted first download cannot be retried. Do not probe the URL; save or process its first response directly. Encoded screenshots are limited to 30 MiB; larger captures complete as failed instructions rather than being retained.

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

# ACOB

ACOB (Agent Controlled Browser) is a small Django server and Chromium extension for controlling browser tabs through an HTTP API.

The server temporarily stores instructions in SQLite. The extension polls for an instruction every second, runs it, and sends the result back. Completed instructions and screenshots are consumed on first read rather than retained as history.

## Local setup

Install dependencies:

```bash
uv sync
```

Prepare the database and start the development server:

```bash
make dev
```

The server listens on `http://127.0.0.1:58347`. Override the address with Make variables when needed, for example `make dev HOST=0.0.0.0 PORT=8000`. Use `make run` instead to serve the application with Uvicorn.

## Docker

Build the image and start the server with Docker Compose:

```bash
docker compose up --build
```

The Compose service applies migrations through `make run` and exposes the server at `http://127.0.0.1:58347`. To run it in the background and follow its logs:

```bash
docker compose up --build --detach
docker compose logs --follow acob
```

Stop and remove the service with `docker compose down`. The SQLite database is stored inside the container, so its data is lost when the container is removed or replaced.

## Browser extension

With either server running, load the extension in Chromium 116 or newer:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose the `extension/` directory.
4. Open the ACOB extension popup and copy its automatically generated browser ID.

The extension defaults to `http://127.0.0.1:58347`; its popup can change the server URL. Each extension installation gets a dashless UUID browser ID. Instructions are stored and claimed under that ID, allowing one server to control multiple independent browsers. Rotating the ID moves the extension to a new instruction queue.

## Python client

An independently installable Python client is available in `client/`:

```bash
pip install ./client
```

It exports `ACOBClient`, which submits instructions, waits for their one-use terminal responses, and returns their browser results:

```python
from acob import ACOBClient

client = ACOBClient("0123456789ab4def8123456789abcdef")
tabs = client.tabs(operation="list")
tab = client.tabs(operation="navigate", url="https://example.com")
title = client.javascript(tab.tid, "document.title")
png = client.screenshot(tab.tid, full_page=True)
```

Pass `endpoint="http://host:port"` to target a non-default server. See [`client/README.md`](client/README.md) for every action, low-level queue access, timeout behavior, and error types.

## API

Set `BID` to the browser ID shown in the extension popup. Create an instruction with `POST /api/browsers/<bid>/instructions/`:

```bash
BID=0123456789ab4def8123456789abcdef
curl -X POST "http://127.0.0.1:58347/api/browsers/$BID/instructions/" \
  -H 'Content-Type: application/json' \
  -d '{"action":"tabs","operation":"list"}'
```

Supported instructions:

```json
{"action":"tabs","operation":"list"}
{"action":"tabs","operation":"navigate","url":"https://example.com"}
{"action":"tabs","operation":"navigate","tid":123,"url":"https://example.com"}
{"action":"tabs","operation":"focus","tid":123}
{"action":"tabs","operation":"close","tid":123}
{"action":"click","tid":123,"selector":"button[type=submit]"}
{"action":"keyboard","tid":123,"text":"ACOB"}
{"action":"keyboard","tid":123,"key":"Enter","modifiers":[]}
{"action":"screenshot","tid":123,"full_page":false}
{"action":"javascript","tid":123,"script":"document.title"}
```

Every `tabs` instruction requires an `operation`. The `list` operation returns each tab's `tid`, window ID, domain, URL, title, active state, and focused state. `active` means selected within its window; `focused` is only true when that tab is active and its window is focused. `navigate` requires a non-empty `url`; it navigates the supplied `tid`, or creates a new tab when `tid` is omitted, waits for the page load event, and returns the tab details. `focus` activates a tab and focuses its containing window. Focusing or closing a tab requires its `tid`.

`click` requires a positive `tid` and a non-empty CSS `selector`. The extension focuses the target tab, scrolls the selected element into view, and sends mouse movement, press, and release input at the center of its rendered border box. The browser performs normal coordinate hit-testing, so an overlay or another element visually above the selected element receives the click instead. The result includes the selector and click coordinates.

`keyboard` requires a positive `tid` and exactly one of `text` or `key`. Text is inserted into the currently focused editable control. Named keys are `ArrowDown`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `Backspace`, `Delete`, `End`, `Enter`, `Escape`, `Home`, `PageDown`, `PageUp`, `Space`, and `Tab`; a single-character key is also accepted. Key input can include unique `alt`, `ctrl`, `meta`, and `shift` modifiers. The extension focuses the target tab and window, but the agent must focus the intended page control first, usually with `click`.

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

`javascript` requires a `tid` and evaluates the supplied script in that tab. Its result must be JSON-serializable. The extension uses Chromium's debugger permission so execution is not blocked by the page's content security policy.

To navigate an existing tab:

```json
{
  "action": "tabs",
  "operation": "navigate",
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

Use the ID returned when creating an instruction to retrieve its status and result:

```bash
curl "http://127.0.0.1:58347/api/browsers/$BID/instructions/1/"
```

Reads are non-destructive while the instruction is `pending` or `processing`. The first detail request after it becomes `completed` or `failed` returns the terminal response and deletes the instruction. Every later request for that ID returns 404. Capture the complete terminal response from the polling request; do not issue another request to fetch its result.

Invalid requests return an `Invalid request` error with a `details` list containing the field, message, and validation type for each problem.

The browser ID must be a lowercase dashless UUIDv4. API clients select a browser by using its ID in every instruction route.

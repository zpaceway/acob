# ACOB

ACOB (Agent Controlled Browser) is a small Django server and Chromium extension for controlling browser tabs through an HTTP API.

The server stores instructions in SQLite. The extension polls for an instruction every second, runs it, and sends the result back.

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
{"action":"tabs","operation":"new"}
{"action":"tabs","operation":"focus","tid":123}
{"action":"tabs","operation":"close","tid":123}
{"action":"click","tid":123,"selector":"button[type=submit]"}
{"action":"javascript","tid":123,"script":"document.title"}
```

Every `tabs` instruction requires an `operation`. The `list` operation returns each tab's `tid`, window ID, domain, URL, title, active state, and focused state. `active` means selected within its window; `focused` is only true when that tab is active and its window is focused. The `new` operation opens an `about:blank` tab and returns its details. The `focus` operation activates a tab and focuses its containing window. Focusing or closing a tab requires its `tid`.

`click` requires a positive `tid` and a non-empty CSS `selector`. The extension focuses the target tab, scrolls the selected element into view, and sends mouse movement, press, and release input at the center of its rendered border box. The browser performs normal coordinate hit-testing, so an overlay or another element visually above the selected element receives the click instead. The result includes the selector and click coordinates.

`javascript` requires a `tid` and evaluates the supplied script in that tab. Its result must be JSON-serializable. The extension uses Chromium's debugger permission so execution is not blocked by the page's content security policy.

To navigate a new or existing tab:

```json
{
  "action": "javascript",
  "tid": 123,
  "script": "location.href = 'https://example.com'"
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

Invalid requests return an `Invalid request` error with a `details` list containing the field, message, and validation type for each problem.

The browser ID must be a lowercase dashless UUIDv4. API clients select a browser by using its ID in every instruction route.

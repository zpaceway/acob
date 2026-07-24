# ACOB

ACOB (Agent Controlled Browser) is a small Django server and Chromium extension for controlling browser tabs through an HTTP API.

The server stores instructions in SQLite. The extension polls for an instruction every second, runs it, and sends the result back.

## Setup

Install dependencies and prepare the database:

```bash
uv sync
uv run manage.py migrate
uv run manage.py runserver
```

Load the extension in Chromium 116 or newer:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose the `extension/` directory.

The server must be available at `http://127.0.0.1:58347`.

## API

Create an instruction with `POST /api/instructions/`:

```bash
curl -X POST http://127.0.0.1:58347/api/instructions/ \
  -H 'Content-Type: application/json' \
  -d '{"action":"tabs","operation":"list"}'
```

Supported instructions:

```json
{"action":"tabs","operation":"list"}
{"action":"tabs","operation":"new"}
{"action":"tabs","operation":"close","tid":123}
{"action":"javascript","tid":123,"script":"document.title"}
```

Every `tabs` instruction requires an `operation`. The `list` operation returns each tab's `tid`, window ID, domain, URL, title, and active state. The `new` operation opens an `about:blank` tab and returns its details. Closing a tab requires its `tid`.

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
curl http://127.0.0.1:58347/api/instructions/1/
```

Invalid requests return an `Invalid request` error with a `details` list containing the field, message, and validation type for each problem.

This initial version has no authentication and is intended for local development only.

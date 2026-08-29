# ACOB MCP Server

This project is the standalone Model Context Protocol service for controlling
a user's existing Chromium session with ACOB. It uses the official
[`mcp`](https://pypi.org/project/mcp/) Python SDK and invokes `acob-client`
in-process. The client communicates with Django over HTTP.

```text
MCP host -> acob-mcp -> acob-client -> Django REST API -> Chromium extension
```

The project is a service, not an installable Python package. Runtime code lives
directly in `src/` and is started through the Makefile.

## Requirements

- Python 3.10 or newer
- [`uv`](https://docs.astral.sh/uv/)
- A running ACOB server and Chromium extension
- Docker with Compose, only for the container workflow

Sync the service dependencies and run it:

```bash
uv sync
make run
```

One process serves connections for multiple browsers. Each Streamable HTTP
connection supplies its browser ID in the URL path. When run standalone:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58348/mcp/0123456789ab4def8123456789abcdef"
    }
  }
}
```

When run behind the unified proxy (`../proxy/compose.yaml`), the same
service is available on the single proxy port (`58346`):

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58346/mcp/0123456789ab4def8123456789abcdef"
    }
  }
}
```

Nothing is configurable per connection: the browser ID is baked into the URL
path, and the ACOB API origin always comes from the `ACOB_ENDPOINT`
environment variable.

Screenshot URLs are served by the ACOB server itself: it stores each capture
locally and reports the public download URL in the instruction result. This
adapter only relays that URL; it never receives or stores the image bytes,
and it never downloads the image itself.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACOB_ENDPOINT` | required | ACOB API origin, always taken from the environment. |
| `ACOB_TIMEOUT` | `60` | Default result-wait deadline in seconds. |
| `ACOB_POLL_INTERVAL` | `0.5` | REST result polling interval in seconds. |
| `ACOB_MCP_HOST` | `127.0.0.1` | HTTP bind address. |
| `ACOB_MCP_PORT` | `58348` | HTTP listen port. |

`ACOB_ENDPOINT` is required: the server refuses to start without it. `make run`
sets `ACOB_MCP_HOST` to `0.0.0.0` and provides a development default for
`ACOB_ENDPOINT`; override any value with Make variables when needed.

The tools are `list`, `navigate`, `focus`, `close`, `reload`, `scroll`,
`click`, `keyboard`, `screenshot`, `record_start`, `record_stop`, `settings`,
`javascript`, `execute_batch`, and `reinstall`. The `screenshot` tool always
returns the
public download URL for the capture; it never streams the image, so the agent
downloads the capture itself when it needs the pixels. `record_start` starts
a bounded video recording and returns its tracking ID; set `full_page` to
record the whole scrollable page instead of the visible viewport.
`record_stop` delivers the recording's public download URL with a
`stopped_reason` and message when the extension's maximum duration was
reached first. `settings` returns the browser's reported configuration
(including `maxRecordingDurationSec` and `maxRecordingSizeMiB`) so agents can
plan recordings and other bounded work. `execute_batch` accepts a list of up
to 20 complete instruction requests that the browser runs sequentially with
one request for the whole cascade, returning one result or error entry per
action.

## Docker

The image uses the sibling client project, so its build context is the
monorepo root. Compose configures this automatically for standalone use:

```bash
docker compose -f mcp/compose.yaml up --build
```

The standalone compose exposes `58348` on the `acob` bridge network and
reaches the API at `http://acob-srv:58347` via the shared Docker network.
For the unified single-port deployment, use the proxy instead:

```bash
docker compose -f ../proxy/compose.yaml up --build
```

This builds both `acob-srv` and `acob-mcp` and fronts them with nginx on
`http://127.0.0.1:58346` (`/mcp/` -> MCP, `/` -> API). The Dockerfile
starts the service with `make run`. Build it without Compose:

```bash
docker build -f mcp/Dockerfile -t acob-mcp .
```

Run verification from `mcp/`:

```bash
make check
make test
```

ACOB and this service have no API authentication or TLS. Keep both on a trusted
local machine unless deployment-specific controls are added.

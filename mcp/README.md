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
- A media storage service configured on the ACOB server for screenshot URLs
- Docker with Compose, only for the container workflow

Sync the service dependencies and run it:

```bash
uv sync
make run
```

One process serves connections for multiple browsers. Each Streamable HTTP
connection supplies its browser ID in the URL path:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58348/mcp/0123456789ab4def8123456789abcdef"
    }
  }
}
```

Nothing is configurable per connection: the browser ID is baked into the URL
path, and the ACOB API origin always comes from the `ACOB_ENDPOINT`
environment variable.

Screenshot URLs returned with `as_url=true` are not served by ACOB: the ACOB
server uploads each capture to the configured media storage service and reports
the public download URL in the instruction result. This adapter only relays
that URL; it never receives or stores the image bytes.

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
`click`, `keyboard`, `screenshot`, `javascript`, and `reinstall`. The
`screenshot` tool always requires `as_url`: `false` streams the PNG image,
`true` returns the public download URL for later analysis.

## Docker

The image uses the sibling client project, so its build context is the
monorepo root. Compose configures this automatically:

```bash
docker compose -f mcp/compose.yaml up --build
```

The Compose service uses the host network, so the container reaches the ACOB
API at `127.0.0.1:58347` exactly as a locally running service would.

The Dockerfile starts the service with `make run`. Build it without Compose:

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

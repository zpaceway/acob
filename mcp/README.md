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

Without a query parameter, the API endpoint defaults to
`http://host.docker.internal:58347`. Use
`?endpoint=http://127.0.0.1:58347` for a locally running API.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEFAULT_ACOB_ENDPOINT` | `http://host.docker.internal:58347` | Default ACOB API origin. |
| `ACOB_TIMEOUT` | `60` | Default result-wait deadline in seconds. |
| `ACOB_POLL_INTERVAL` | `0.5` | REST result polling interval in seconds. |
| `ACOB_MCP_HOST` | `127.0.0.1` | HTTP bind address. |
| `ACOB_MCP_PORT` | `58348` | HTTP listen port. |

`make run` sets `ACOB_MCP_HOST` to `0.0.0.0`; override either value with Make
variables when needed.

The tools are `list`, `navigate`, `focus`, `close`, `reload`, `scroll`,
`click`, `keyboard`, `screenshot`, `javascript`, and `reinstall`.

## Docker

The image uses the sibling client project, so its build context is the
monorepo root. Compose configures this automatically:

```bash
docker compose -f mcp/compose.yaml up --build
```

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

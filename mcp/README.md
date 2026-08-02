# ACOB MCP Server

This project is the standalone Model Context Protocol server for controlling a
user's existing Chromium session with ACOB. It uses the official
[`mcp`](https://pypi.org/project/mcp/) Python SDK and invokes the public
`acob-client` API in-process. The client communicates with Django over HTTP.
The adapter does not import Django, access ACOB's database, or share a process
with `../srv/`.

```text
MCP host -> acob-mcp -> acob-client -> Django REST API -> Chromium extension
```

One process controls one browser. Set `ACOB_BID` when starting the process;
the browser ID is runtime routing configuration, not authentication.

## Requirements

- Python 3.10 or newer
- [`uv`](https://docs.astral.sh/uv/)
- A running ACOB server and Chromium extension
- Docker with Compose, only for the container workflow

From a monorepo checkout, install the project and its development dependencies
from this directory:

```bash
uv sync
```

The local uv source points `acob-client` at `../client/`. Published wheels and
source distributions retain the normal `acob-client>=0.4.0` dependency and can
be installed without the monorepo sibling.

## Stdio

Stdio is the default transport. MCP hosts launch one process for each browser:

```json
{
  "mcpServers": {
    "acob": {
      "command": "uv",
      "args": [
        "--directory",
        "/absolute/path/to/acob/mcp",
        "run",
        "acob-mcp"
      ],
      "env": {
        "ACOB_BID": "0123456789ab4def8123456789abcdef",
        "ACOB_ENDPOINT": "http://127.0.0.1:58347"
      }
    }
  }
}
```

## Streamable HTTP

Run the same app as an independent Streamable HTTP server:

```bash
ACOB_BID=0123456789ab4def8123456789abcdef \
  ACOB_MCP_TRANSPORT=streamable-http \
  uv run acob-mcp
```

Clients connect to `http://127.0.0.1:58349/mcp`. The BID is already fixed by
the process, so clients do not send a custom header:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58349/mcp"
    }
  }
}
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACOB_BID` | required | Lowercase dashless UUIDv4 shown by the extension. |
| `ACOB_ENDPOINT` | `http://127.0.0.1:58347` | Django REST API origin. |
| `ACOB_TIMEOUT` | `60` | Default result-wait deadline in seconds. |
| `ACOB_POLL_INTERVAL` | `0.5` | REST result polling interval in seconds. |
| `ACOB_MCP_TRANSPORT` | `stdio` | `stdio` or `streamable-http`. |
| `ACOB_MCP_HOST` | `127.0.0.1` | HTTP bind address. |
| `ACOB_MCP_PORT` | `58349` | HTTP listen port. |
| `ACOB_MCP_PATH` | `/mcp` | Streamable HTTP route. |
| `ACOB_MCP_ALLOWED_HOSTS` | localhost variants | Comma-separated HTTP Host allowlist. |
| `ACOB_MCP_ALLOWED_ORIGINS` | localhost variants | Comma-separated HTTP Origin allowlist. |

Every queued browser-action tool accepts an optional positive `timeout`
override for result polling after submission. It is not an end-to-end MCP call
deadline. `reinstall` uses the recovery channel and has no timeout argument.
Host and Origin allowlists are enforced by the MCP SDK to protect local HTTP
servers from DNS rebinding. Add explicit entries before using another hostname.

## Tools

- `list`: list tabs.
- `navigate`: navigate a tab, or open an inactive tab when `tid` is omitted.
- `focus`: focus a tab and its window.
- `close`: close a tab.
- `reload`: reload a tab and wait for it to load.
- `scroll`: scroll a tab vertically by `y` CSS pixels.
- `click`: click the center of a CSS-selected element.
- `keyboard`: insert text or dispatch one key with optional modifiers.
- `screenshot`: return a PNG MCP image content block.
- `javascript`: evaluate JavaScript and return its JSON value.
- `reinstall`: reload the unpacked extension from disk and interrupt active work.

Positive `scroll.y` values move down and negative values move up. `reload` is a
queued instruction for one tab. `reinstall` uses the extension recovery endpoint
after rebuilding the unpacked files.

The SDK derives input and output schemas from the typed functions. ACOB client
failures are returned as MCP tool errors so the calling model can respond.
Accepted browser instructions can outlive a cancelled or timed-out MCP call;
the REST API has no instruction-cancellation endpoint.

## Docker

The image uses the sibling client project, so build it with the monorepo root as
the context. Compose configures this automatically and starts only the MCP
adapter. Start the API independently, for example:

```bash
docker compose -f srv/compose.yaml up --detach --build
```

Then run the adapter from the repository root:

```bash
ACOB_BID=0123456789ab4def8123456789abcdef \
  docker compose -f mcp/compose.yaml up --build
```

Compose publishes only MCP on `127.0.0.1:58349`. The default `ACOB_ENDPOINT` is
`http://host.docker.internal:58347`, which reaches the port published by the
independent `acob-srv` Compose service. Override it when the API is elsewhere.
The image and container are both named `acob-mcp`. Set `ACOB_MCP_PORT` to change
the published MCP host port. Build the adapter image without Compose with:

```bash
docker build -f mcp/Dockerfile -t acob-mcp .
```

Run checks and package builds independently:

```bash
make check
make test
make build
```

ACOB and this adapter have no API authentication or TLS. Keep both on a trusted
local machine unless deployment-specific controls are added.

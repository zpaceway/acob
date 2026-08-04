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

One process serves connections for multiple browsers. Each Streamable HTTP
connection supplies its browser ID in the URL path and can override its Django
API origin with the `endpoint` query parameter. These values are runtime
routing configuration, not authentication.

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

## Streamable HTTP

Run the Streamable HTTP server:

```bash
uv run acob-mcp
```

Clients must include the browser ID after the configured MCP path:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58349/mcp/0123456789ab4def8123456789abcdef"
    }
  }
}
```

Without a query parameter, the endpoint defaults to
`http://host.docker.internal:58347`, which is the API address reachable from
the Docker-based MCP deployment. To target another API origin, use
`?endpoint=http://127.0.0.1:58347`. A blank `endpoint` query value fails the
MCP connection request.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACOB_TIMEOUT` | `60` | Default result-wait deadline in seconds. |
| `ACOB_POLL_INTERVAL` | `0.5` | REST result polling interval in seconds. |
| `ACOB_MCP_HOST` | `127.0.0.1` | HTTP bind address. |
| `ACOB_MCP_PORT` | `58349` | HTTP listen port. |
| `ACOB_MCP_PATH` | `/mcp` | Streamable HTTP path prefix; the browser ID is appended. |
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
docker compose -f mcp/compose.yaml up --build
```

Compose publishes only MCP on `127.0.0.1:58349`. Connect with
`http://127.0.0.1:58349/mcp/<bid>` to use the default endpoint, or add an
`endpoint` query parameter for another API origin. The default is reachable
from the container at `http://host.docker.internal:58347`, which points to the
API port published by the independent `acob-srv` Compose service. The image
and container are both named `acob-mcp`. Set `ACOB_MCP_PORT` to change the
published MCP host port. Build the adapter image without Compose with:

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

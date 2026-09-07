# ACOB MCP Server

This project is the standalone Model Context Protocol service for controlling
a user's existing Chromium session with ACOB. It uses the official
[`mcp`](https://pypi.org/project/mcp/) Python SDK and invokes `acob-client`
in-process. The client communicates with Django over HTTP.

```text
MCP host -> acob-mcp -> acob-client -> Django REST API -> Chromium extension
```

The project is a service, not an installable Python package. Runtime code lives
directly in `src/` and is started through the Makefile. One process controls the
single global queue of the ACOB installation selected by `ACOB_ENDPOINT`.

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

The Streamable HTTP path is fixed at `/mcp`. For direct native development:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58348/mcp"
    }
  }
}
```

When run behind the unified proxy (root `compose.yaml`), the same
service is available on the single proxy port (`58346`):

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58346/mcp"
    }
  }
}
```

Nothing is configurable per connection. The ACOB API origin always comes from
the `ACOB_ENDPOINT` environment variable, and every connection uses that
installation's same queue and Chromium extension.

The root installer requires `NAME` and names every installation context
`acob-<port>-<name>`. Root `install-opencode` and `install-claude` use that same
context as the default MCP registration name; `MCP_NAME` can override the
registration label. The name distinguishes a user or work context only. It is
not sent through MCP or the browser protocol, adds no executor identity or queue
routing, and every connection to an endpoint still shares that stack's
promiscuous queue.

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

`ACOB_ENDPOINT` is required: the service refuses to start without it. `make run`
sets `ACOB_MCP_HOST` to `0.0.0.0` and supplies the native-development API
default `http://127.0.0.1:58347`; override any value with Make variables when
needed. The recommended full stack uses the proxy on `58346`, while the MCP
container reaches the API internally at `http://acob-srv:58347`.

The tools are `list`, `navigate`, `focus`, `close`, `reload`, `scroll`,
`click`, `keyboard`, `screenshot`, `record`, `console`, `proxy`, `cleanup`,
`javascript`, `execute_batch`, and `reinstall`. The `screenshot` tool always
returns the
public download URL for the capture; it never streams the image, so the agent
downloads the capture itself when it needs the pixels. `record` with
`method: start` starts a bounded video recording keyed by tab (one per tab);
set `full_page` to record the whole scrollable page instead of the visible
viewport. `record` with `method: stop` for the same `tid` delivers the
recording's public download URL with a `stopped_reason` and message when the
extension's maximum duration was reached first. `console` with
`method: start`, `method: capture`, and `method: stop` for the same `tid`
captures console messages keyed by tab (one per tab); `capture` returns a
cumulative snapshot as a public JSON download URL without stopping, and
`stop` delivers the final snapshot URL, so the agent downloads the file
itself when it needs the entries. `proxy` with `method: set`
(`http://`, `https://`, or `socks5://` with optional auth) or `method: unset`
controls the browser-wide egress proxy; it is global, not per-tab, and
results never echo credentials. `cleanup` clears all browser data except the
ACOB extension itself across the whole profile; the extension only accepts
it when its Allow browser cleanup setting is enabled locally in its popup;
otherwise it fails. It is browser-global and destructive, fails while a
recording is active, and should be quiesced like `proxy`. Extension limits are
also local and are not exposed through an MCP tool. `execute_batch` accepts a
list of up to 20 complete instruction requests that the browser runs
sequentially with one request for the whole cascade, returning one result or
error entry per action.

## Docker

The image uses the sibling client project, so its build context is the
monorepo root. There is no component Compose file; use the root `compose.yaml`
from the monorepo root:

```bash
docker compose -f compose.yaml up --build
```

To build or start only this service:

```bash
docker compose -f compose.yaml up --build acob-mcp
```

It only exposes `58348` to its Compose project's internal network and publishes
no host port. It requires an API reachable as `http://acob-srv:58347` on that
network. For the complete single-port deployment, use the root installer:

```bash
make -C .. install PORT=58346 NAME=default
make -C .. install PORT=61554 NAME=alexandro
```

This builds `acob-srv`, `acob-mcp`, the proxy image, and a managed Chromium
browser with the extension preinstalled. It creates a project-specific network,
server data volume, and browser profile volume. The proxy publishes the selected
API/MCP host port. The first example uses Compose project and context
`acob-58346-default`; all named installs apply the project prefix to network,
volume, container, and image resources. `NAME` allows lowercase
letters, digits, and internal hyphens and cannot start or end with a hyphen.
Lifecycle commands must receive the same `PORT` and `NAME`. Distinct
installations still require distinct ports because only one process can bind a
host port. The Dockerfile starts the service with `make run`. Build it without
Compose, from the monorepo root:

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

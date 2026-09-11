# ACOB Proxy

The proxy image is the API and MCP entrypoint for a containerized ACOB
installation. It publishes one localhost port and routes by path:

```text
http://127.0.0.1:58346/mcp  -> acob-mcp:58348   (MCP Streamable HTTP)
http://127.0.0.1:58346/vnc  -> acob-browser:6080 (optional noVNC)
http://127.0.0.1:58346/*    -> acob-srv:58347   (Django API and /api/media/*)
```

The server, MCP service, proxy, and managed browser share a
Compose-project-local `acob` network. The server and MCP containers only expose
their ports on that network; neither publishes a host port. MCP-to-API traffic
stays internal at `http://acob-srv:58347`, and the browser extension polls
`http://acob-proxy`.

## Install

Docker with Compose is required. From the monorepo root, install a complete
local stack including its managed browser:

```bash
make install ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
make install ACOB_PROXY_PORT=61554 ACOB_APPLICATION_NAME=alexandro
```

`ACOB_PROXY_PORT` is optional and defaults to `58346`, but `ACOB_APPLICATION_NAME` is required. The
installation context is always `acob-<port>-<name>`. `ACOB_APPLICATION_NAME` may contain lowercase
letters, digits, and internal hyphens, but cannot start or end with a hyphen. The
command:

- builds the extension for `http://acob-proxy`, then passes the built directory
  into the browser image build;
- starts Compose with project name `<context>`;
- creates network, volume, container, and image resources with that project
  prefix; and
- publishes nginx at `127.0.0.1:<port>`.

Set `ACOB_EXTENSION_PATH=/path/to/extension` to use an existing built extension
directory instead. Custom builds are not rebuilt and must already contain a
`manifest.json` with the intended initial server URL.

The first example uses context `acob-58346-default` and a project-scoped
ephemeral browser profile. Names distinguish user or work contexts, but beyond
the per-browser `bid` target they add no protocol routing: untargeted work on
one stack remains claimable by any connected browser. Distinct installations
require distinct `ACOB_PROXY_PORT` values
because only one process can bind each host port.

Root lifecycle commands must use the same `ACOB_PROXY_PORT` and `ACOB_APPLICATION_NAME` as installation:

```bash
make up ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
make logs ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
make ps ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
make down ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
make purge ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default

make logs ACOB_PROXY_PORT=61554 ACOB_APPLICATION_NAME=alexandro
make down ACOB_PROXY_PORT=61554 ACOB_APPLICATION_NAME=alexandro
```

`down` preserves the project volumes. `purge` removes them along with the stack.
Both `up` and `install` rebuild changed images.

## MCP Clients

The root installers build and start the full stack and register its fixed
`/mcp` endpoint:

```bash
make install-opencode ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
make install-claude ACOB_PROXY_PORT=58346 ACOB_APPLICATION_NAME=default
make install-opencode ACOB_PROXY_PORT=61554 ACOB_APPLICATION_NAME=alexandro
make install-claude ACOB_PROXY_PORT=61554 ACOB_APPLICATION_NAME=alexandro
```

The registration name defaults to the installation context
`acob-<port>-<name>`. The URL is
`http://127.0.0.1:<port>/mcp`. Override `ACOB_MCP_NAME`, `ACOB_OPENCODE_BIN`, or
`ACOB_CLAUDE_BIN` when needed. Restart or reconnect the MCP client after installation
so it discovers the current tool schemas. This name is an MCP client label, not
a protocol selector; queue selection still comes only from the endpoint port.

Manual MCP configuration for the default port is:

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58346/mcp"
    }
  }
}
```

## Endpoints

The default proxy exposes the flat, single-queue interfaces:

- REST API: `http://127.0.0.1:58346/api/instructions/`
- API guide: `/api/`, Swagger UI: `/api/docs/`, OpenAPI: `/api/openapi.json`
- Media: `http://127.0.0.1:58346/api/media/<file>`
- Reinstall: `http://127.0.0.1:58346/api/reinstall/`
- MCP Streamable HTTP: `http://127.0.0.1:58346/mcp`
- Optional noVNC debugger: `http://127.0.0.1:58346/vnc`

The per-browser `bid` travels as an optional instruction field, a `?bid=`
claim/result parameter, and a read-only popup value (Copy/Rotate); there is no
heartbeat or settings
endpoint. Extension settings and limits remain local to the extension popup.

## Compose

The root Makefile is the recommended interface because it consistently derives
the context from `ACOB_PROXY_PORT` and required `ACOB_APPLICATION_NAME`. The equivalent direct command for
the first example, run from the monorepo root, is:

```bash
ACOB_PROXY_PORT=58346 docker compose --project-name acob-58346-default --file compose.yaml up --build
```

Pre-existing unnamed contexts are outside the supported root lifecycle. Manage
them manually with direct Compose commands or replace them with a named install.

The root `compose.yaml` is the only Compose file. It defines five services
(`acob-db`, `acob-srv`, `acob-mcp`, `acob-proxy`, `acob-browser`) plus the project-scoped
`acob` network and data volumes (`db-data` for Postgres, `srv-data` for media).
Do not assign a global network name:
project scoping is what isolates installations.

There are no component Compose files. For individual-service development, use
native `make -C srv run` and `make -C mcp run` when direct host access on
`58347` and `58348` is needed.

## nginx Configuration

Documentation is served by Django through the generic `/` route. nginx preserves
the request Host including its port, so generated documentation targets the
origin the caller used. Compose sets `ACOB_MCP_API_SAME_ORIGIN=true` for MCP to
produce matching links while retaining its internal API execution endpoint.

`proxy/Dockerfile` copies `nginx.conf` into the proxy image. The configuration:

- listens on container port `80`, mapped only to `127.0.0.1:${ACOB_PROXY_PORT}`;
- proxies `/mcp` to `acob-mcp:58348` with HTTP/1.1, buffering disabled, and
  3600-second streaming timeouts;
- redirects `/vnc` to noVNC's full client and proxies `/vnc/` plus its
  WebSocket to `acob-browser:6080`;
- proxies every other path to `acob-srv:58347`;
- accepts request bodies up to `1024M` for bounded recordings and screenshot
  batches; and
- uses Docker's embedded DNS so included services resolve at request time.

ACOB has no API authentication or TLS. Keep the published proxy bound to the
trusted local machine unless deployment-specific controls are added.

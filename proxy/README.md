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
make install PORT=58346 NAME=default
make install PORT=61554 NAME=alexandro
```

`PORT` is optional and defaults to `58346`, but `NAME` is required. The
installation context is always `acob-<port>-<name>`. `NAME` may contain lowercase
letters, digits, and internal hyphens, but cannot start or end with a hyphen. The
command:

- builds the extension for `http://acob-proxy`, then passes the built directory
  into the browser image build;
- starts Compose with project name `<context>`;
- creates network, volume, container, and image resources with that project
  prefix; and
- publishes nginx at `127.0.0.1:<port>`.

Set `EXTENSION_PATH=/path/to/extension` to use an existing built extension
directory instead. Custom builds are not rebuilt and must already contain a
`manifest.json` with the intended initial server URL.

The first example uses context `acob-58346-default` and a project-scoped
persistent browser profile. Names distinguish user or work contexts, but they do not add protocol routing
or executor identity: every extension connected to one stack still consumes
its promiscuous queue. Distinct installations require distinct `PORT` values
because only one process can bind each host port.

Root lifecycle commands must use the same `PORT` and `NAME` as installation:

```bash
make up PORT=58346 NAME=default
make logs PORT=58346 NAME=default
make ps PORT=58346 NAME=default
make down PORT=58346 NAME=default
make purge PORT=58346 NAME=default

make logs PORT=61554 NAME=alexandro
make down PORT=61554 NAME=alexandro
```

`down` preserves the project volumes. `purge` removes them along with the stack.
Both `up` and `install` rebuild changed images.

## MCP Clients

The root installers build and start the full stack and register its fixed
`/mcp` endpoint:

```bash
make install-opencode PORT=58346 NAME=default
make install-claude PORT=58346 NAME=default
make install-opencode PORT=61554 NAME=alexandro
make install-claude PORT=61554 NAME=alexandro
```

The registration name defaults to the installation context
`acob-<port>-<name>`. The URL is
`http://127.0.0.1:<port>/mcp`. Override `MCP_NAME`, `OPENCODE_BIN`, or
`CLAUDE_BIN` when needed. Restart or reconnect the MCP client after installation
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
- Media: `http://127.0.0.1:58346/api/media/<file>`
- Reinstall: `http://127.0.0.1:58346/api/reinstall/`
- MCP Streamable HTTP: `http://127.0.0.1:58346/mcp`
- Optional noVNC debugger: `http://127.0.0.1:58346/vnc`

There is no browser identifier in any route and no heartbeat or settings
endpoint. Extension settings and limits remain local to the extension popup.

## Compose

The root Makefile is the recommended interface because it consistently derives
the context from `PORT` and required `NAME`. The equivalent direct command for
the first example, run from the monorepo root, is:

```bash
PORT=58346 docker compose --project-name acob-58346-default --file compose.yaml up --build
```

Pre-existing unnamed contexts are outside the supported root lifecycle. Manage
them manually with direct Compose commands or replace them with a named install.

The root `compose.yaml` is the only Compose file. It defines four services
(`acob-srv`, `acob-mcp`, `acob-proxy`, `acob-browser`) plus the project-scoped
`acob` network and data volumes. Do not assign a global network name:
project scoping is what isolates installations.

There are no component Compose files. For individual-service development, use
native `make -C srv run` and `make -C mcp run` when direct host access on
`58347` and `58348` is needed.

## nginx Configuration

`proxy/Dockerfile` copies `nginx.conf` into the proxy image. The configuration:

- listens on container port `80`, mapped only to `127.0.0.1:${PORT}`;
- proxies `/mcp` to `acob-mcp:58348` with HTTP/1.1, buffering disabled, and
  3600-second streaming timeouts;
- redirects `/vnc` to noVNC's lightweight client and proxies `/vnc/` plus its
  WebSocket to `acob-browser:6080`;
- proxies every other path to `acob-srv:58347`;
- accepts request bodies up to `1024M` for bounded recordings and screenshot
  batches; and
- uses Docker's embedded DNS so included services resolve at request time.

ACOB has no API authentication or TLS. Keep the published proxy bound to the
trusted local machine unless deployment-specific controls are added.

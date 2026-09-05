# ACOB Proxy

Unified entrypoint for ACOB. An `nginx:alpine` front proxies both
services over a single host port, routing by path:

```text
http://127.0.0.1:58346/mcp/*  -> acob-mcp:58348   (MCP Streamable HTTP)
http://127.0.0.1:58346/*      -> acob-srv:58347   (Django API + /api/media/*)
```

MCP->API traffic stays inside the `acob` Docker network
(`http://acob-srv:58347`), so `srv` and `mcp` no longer need
`network_mode: host` or host-published ports.

## Requirements

- Docker with Compose
- The `acob-srv` and `acob-mcp` images build from `../srv` and `../mcp`

## Usage

From the monorepo root:

```bash
docker compose -f proxy/compose.yaml up --build
```

Or via the Makefile:

```bash
make -C proxy docker   # up --build --detach
make -C proxy logs     # follow acob-proxy
make -C proxy down
```

## MCP client installers

The installer targets bring up the full stack (`docker compose up -d --build`)
and register the MCP server with the chosen client. `BID` is required: copy
the browser ID from the ACOB extension popup.

```bash
make -C proxy install-opencode BID=0123456789ab4def8123456789abcdef
make -C proxy install-claude BID=0123456789ab4def8123456789abcdef
```

- `install-opencode` registers `acob` via `opencode mcp add --url
  http://127.0.0.1:58346/mcp/<bid>`. Restart/reconnect the opencode session
  afterwards so it picks up the new tools.
- `install-claude` registers `acob` via `claude mcp add --transport http -s
  user` (user scope, re-runnable). Start a new Claude Code session to use the
  tools.

Overrides:

```bash
make -C proxy install-opencode BID=<bid> ACOB_PROXY_PORT=8000
make -C proxy install-claude BID=<bid> OPENCODE_BIN=/path/to/opencode CLAUDE_BIN=/path/to/claude
```

Verify the registration with `opencode mcp list` or `claude mcp list`.

Override the unified host port:

```bash
ACOB_PROXY_PORT=8000 docker compose -f proxy/compose.yaml up --build
```

The API remains available at (via the proxy):

- `POST http://127.0.0.1:58346/api/browsers/<bid>/instructions/`
- `GET  http://127.0.0.1:58346/api/media/<file>`
- MCP Streamable HTTP at `http://127.0.0.1:58346/mcp/<bid>`

For MCP clients (via proxy):

```json
{
  "mcpServers": {
    "acob": {
      "url": "http://127.0.0.1:58346/mcp/0123456789ab4def8123456789abcdef"
    }
  }
}
```

When running standalone via `make -C srv run` / `make -C mcp run` the
services bind directly to `http://127.0.0.1:58347` and `http://127.0.0.1:58348`.
The standalone compose files (`srv/compose.yaml`, `mcp/compose.yaml`) now
only `expose` on the internal `acob` network — host access is via this
proxy at `58346`.

`ACOB_SRV` and `ACOB_MCP` environment passthrough is still supported
via the unified compose (`ACOB_TIMEOUT`, `ACOB_POLL_INTERVAL`).

## nginx config

`nginx.conf` is mounted read-only into the proxy container. It:

- listens on `80` inside the container (mapped to `ACOB_PROXY_PORT` on the host, default `58346`)
- proxies `/mcp/` to `acob-mcp:58348` with `Upgrade`/`Connection` headers,
  `proxy_http_version 1.1`, buffering disabled and 3600s timeouts for MCP streaming
- proxies `/` to `acob-srv:58347` with `client_max_body_size 1024M` to allow
  512 MiB recordings and 30 MiB screenshots
- uses `resolver 127.0.0.11` (Docker embedded DNS) with variables so nginx
  defers upstream resolution to request time

All three services share the `acob` bridge network (`name: acob`),
so `srv` and `mcp` are reachable by service name without host networking.
`proxy/compose.yaml` reuses the existing definitions via Compose `include`:

```yaml
include:
  - path: ../srv/compose.yaml
  - path: ../mcp/compose.yaml
```

so `srv`/`mcp` are not rewritten — the proxy only adds `acob-proxy` and
routes by path.

## Standalone srv / mcp

`../srv/compose.yaml` and `../mcp/compose.yaml` now also use the `acob`
bridge network and `expose:` instead of `network_mode: host`. They can still
be run individually for development (`docker compose -f srv/compose.yaml up`
exposes only internally; use `make -C srv run` for host `58347`), but the
recommended way to run the full stack is through this proxy compose.

## Verification

```bash
BID=0123456789ab4def8123456789abcdef
curl http://127.0.0.1:58346/api/browsers/$BID/settings/  # via proxy -> srv
curl -N http://127.0.0.1:58346/mcp/$BID  # via proxy -> mcp Streamable HTTP
```

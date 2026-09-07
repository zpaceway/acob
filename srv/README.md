# ACOB Server

The server is the Django API and single global SQLite queue for ACOB. API clients
submit browser instructions, the Chromium extension claims and completes them,
and clients poll for the resulting browser output. The server does not execute
browser actions itself and does not serve the static site in `../web/`.

## Requirements

- Python 3.14 or newer
- [`uv`](https://docs.astral.sh/uv/)
- Docker with Compose, only when using the container workflow

## Local Development

Run commands from this directory:

```bash
uv sync
make dev
```

`make dev` applies migrations and binds Django to `0.0.0.0:58347`. Override the
bind address with Make variables:

```bash
make dev ACOB_SRV_HOST=0.0.0.0 ACOB_SRV_PORT=8000
```

Use `make run` to apply migrations and serve `acob.asgi:application` with
Uvicorn. Both commands use the development settings in `acob/settings.py`.

Screenshots and recordings are stored locally under `media/` (`MEDIA_ROOT`)
and served by this server at `/api/media/<filename>`. No external storage
service is configured; when storing a capture fails, the instruction
completes as failed with a clear error.

Set `ACOB_DATA_DIR` to move both SQLite and locally hosted captures. Set
`ACOB_PUBLIC_URL` when capture download URLs need an origin other than the
incoming request host. Compose sets it to `http://127.0.0.1:${PORT}` because
the managed browser reaches nginx through its internal service name.

Create and apply migrations separately with `make migrations` and
`make migrate`.

## Verification

```bash
make check
make test
```

`make check` runs Ruff (lint and format check), ty (strict type checking),
Django's system checks, and a missing-migration check. `make test` runs the
API test suite. `make format` applies Ruff fixes and formatting.

## Docker

The Dockerfile expects `srv/` to be the build context. There is no component
Compose file; use the root `compose.yaml` from the monorepo root:

```bash
docker compose -f compose.yaml up --build
```

To build or start only this service:

```bash
docker compose -f compose.yaml up --build acob-srv
```

The service exposes `58347` only to its Compose project's internal `acob`
network and publishes no host port. When run via root `compose.yaml`,
it is reachable internally as `http://acob-srv:58347` and publicly only through
the proxy at `http://127.0.0.1:58346` by default. Compose stores SQLite and
media under `/data` in the project-scoped `srv-data` volume. A root
`make install PORT=... NAME=...` requires `NAME` and uses installation context
and project `acob-<port>-<name>`. For example,
`make install PORT=61554 NAME=alexandro` uses `acob-61554-alexandro` and starts
a managed browser with a project-scoped profile. `NAME` may
contain lowercase letters, digits, and internal hyphens, but cannot start or end
with a hyphen. Compose network, volume, container, and image resources use that
project prefix, and the root OpenCode and Claude installers use the context as
their default MCP registration name.

Lifecycle commands must receive the same `PORT` and `NAME`. Distinct
installations still require distinct ports because only one process can bind a
host port. A name only distinguishes a user or work context; it does not add
server protocol routing or executor identity, and this server's queue remains
promiscuous within its stack.

## API

All routes are flat under `/api/` and operate on the one queue for this local
server.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/instructions/` | Validate and enqueue an instruction. |
| `POST` | `/api/instructions/batch/` | Enqueue one instruction that runs up to 20 actions sequentially. |
| `GET` | `/api/instructions/next/?limit=1` | Claim 1 to 20 pending instructions for the extension. |
| `GET` | `/api/instructions/<id>/` | Read status or consume a terminal response. |
| `POST` | `/api/instructions/<id>/result/` | Complete a claimed instruction. |
| `POST` | `/api/reinstall/` | Queue an unpacked-extension reinstall. |
| `GET` | `/api/reinstall/` | Read the pending reinstall command for manual inspection. |
| `POST` | `/api/reinstall/acknowledge/` | Acknowledge recovery from the new worker. |
| `GET` | `/api/media/<name>` | Serve a stored screenshot, recording, or console capture. |

Supported actions are `list`, `navigate`, `focus`, `close`, `reload`, `scroll`,
`click`, `keyboard`, `screenshot`, `record`, `proxy`, `cleanup`, `console`, and
`javascript`. See the root [API guide](../README.md#api) for payload examples.

`POST /api/instructions/batch/` accepts `{"action": "batch", "actions": [...]}`
with 1 to 20 complete instruction requests. The extension executes the
actions strictly in order and completes the single instruction with one
result or error entry per action; a failed action does not stop the rest of
the batch. Only the batch route accepts the `batch` action, and the result
route validates each entry against its action's result model (screenshots and
recordings are stored through the same local media pipeline per entry).

Instructions are transport state, not history. Pending and processing reads are
non-destructive. The first successful detail request for a completed or failed
instruction returns its terminal response and deletes the row.

Screenshots and recordings are stored locally by this server under
`media/` (`MEDIA_ROOT`, created on first use) and served at
`/api/media/<filename>`; the instruction result carries the absolute URL on
this server itself. Recordings use the same pipeline: `record` with
`method: start` (with an optional `full_page` flag to record the whole
scrollable page) and `method: stop` for the same `tid` are instructions
whose stop result carries the final video URL, and the extension-side
session is keyed by tab (one recording per tab) and not tracked by the
server. Console captures use the same local media pipeline: `console` with
`method: start` begins collection for a `tid` and completes with
`{started}`, while `method: capture` and `method: stop` for the same `tid`
upload a base64 JSON document (`application/json` with `entries`,
`size_bytes`, and `truncated`, up to 10 MiB base64) that the server decodes
and stores as `console-{tid}-<uuid>.json` and returns as an absolute
`/api/media/` URL; the extension-side session is keyed by tab and not
tracked by the server. The `proxy` action (`method: set` with a proxy string like
`http://host:port`, `method: unset`) is browser-global and carries only
redacted results. The `cleanup` action (no payload fields) is browser-global
and destructive: it clears cookies, localStorage, history, cache, and
related site data except the extension itself, and its result
`{cleaned: true}` is validated. The extension only accepts it when its
"Allow browser cleanup" popup setting is enabled. Like the SQLite database,
the media directory lives on the local filesystem. The Compose deployment
persists both in its project-scoped `srv-data` volume; purging that volume
starts with an empty queue and media root.

While a reinstall is pending, `/api/instructions/next/` claims no queue work and
instead returns the `reinstall` command directly to the extension; the
extension does not poll the reinstall route separately. The extension persists
the command token, stops active JavaScript work, reloads affected tabs, calls
`chrome.runtime.reload()`, and acknowledges after its new worker starts. The
reinstall request conditionally fails work that is already `processing`, and
the acknowledgement catches any processing race before removing the command.
Pending instructions remain available to the restarted extension.

## Storage And Security

The default configuration is for trusted local development only:

- SQLite stores the global queue state in `db.sqlite3`.
- `media/` holds screenshots and recordings; any client that can reach the
  server can fetch them from `/api/media/<filename>`.
- `DEBUG` is enabled, `ALLOWED_HOSTS` accepts every host, and the secret key is
  committed as a development value.
- Queue endpoints have no authentication, and API POST routes are CSRF-exempt.
- ACOB does not provide TLS, rate limiting, expiry cleanup, or tenant isolation.
- When run through root `compose.yaml`, the proxy publishes a single host
  port (`58346` by default) and routes `/mcp` to the MCP service and everything
  else to this API. The `acob-srv` service in root `compose.yaml` only exposes
  the service on its Compose project's internal `acob` network; it never
  publishes a host port. Use
  `make dev` or `make run` for direct native development on `58347`.

Do not expose this configuration directly to an untrusted network. Review
[`SECURITY.md`](../SECURITY.md) and add authentication, transport security, and
production settings before considering a remote deployment.

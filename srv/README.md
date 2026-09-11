# ACOB Server

The server is the Django API and single global instruction queue for ACOB. API clients
submit browser instructions, the Chromium extension claims and completes them,
and clients poll for the resulting browser output. The server does not execute
browser actions itself and does not serve the static site in `../web/`.
Postgres is the Compose default (via the `acob-db` service); plain
`make dev` without a configured DB falls back to local SQLite.

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

Set `ACOB_DATA_DIR` to move the SQLite fallback file and locally hosted
captures. Set
`ACOB_PUBLIC_URL` when capture download URLs need an origin other than the
incoming request host. Compose sets it to `http://127.0.0.1:${PORT}` because
the managed browser reaches nginx through its internal service name.

Create and apply migrations separately with `make migrations` and
`make migrate`.

### Database

Postgres is the Compose default via the `acob-db` service (see
[`database/README.md`](../database/README.md)); SQLite is only a local-dev
fallback. Selection order in `acob/settings.py`:

1. `ACOB_DATABASE_URL` (fallback `DATABASE_URL`), e.g.
   `postgres://acob:acob@acob-db:5432/acob`;
2. Postgres from `ACOB_DB_HOST` plus `ACOB_DB_NAME` / `ACOB_DB_USER` /
   `ACOB_DB_PASSWORD` / `ACOB_DB_PORT` (Compose sets host `acob-db`, port
   `5432`, name/user/password from `POSTGRES_*`);
3. otherwise SQLite at `DATA_DIR/db.sqlite3` for local dev without a DB.

The container entrypoint waits for Postgres when one is configured, then runs
migrations, `collectstatic`, and `ensure_superuser` before starting the server.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACOB_DATABASE_URL` / `DATABASE_URL` | unset (SQLite fallback) | Single Postgres URL (preferred for overrides). |
| `ACOB_DB_HOST` / `ACOB_DB_PORT` | unset / `5432` | Postgres host/port; setting `ACOB_DB_HOST` selects Postgres. |
| `ACOB_DB_NAME` / `ACOB_DB_USER` / `ACOB_DB_PASSWORD` | `acob` / `acob` / `acob` | Postgres credentials (Compose wires `POSTGRES_*`). |
| `ACOB_DEBUG` / `DJANGO_DEBUG` | `true` | Django debug mode; Compose sets `ACOB_DEBUG=false`. |
| `ACOB_SECRET_KEY` / `DJANGO_SECRET_KEY` | dev fallback (DEBUG only) | Required when `DEBUG` is false; boot fails without it. |
| `ACOB_ALLOWED_HOSTS` | `*` | Allowed hosts list (CSV). |
| `ACOB_CSRF_TRUSTED_ORIGINS` / `CSRF_TRUSTED_ORIGINS` | unset | Trusted origins list (CSV). |
| `ACOB_DATA_DIR` | repo `srv/` | SQLite fallback + media root parent. |
| `ACOB_PUBLIC_URL` | unset (request origin) | Origin for capture download URLs. |

### Static files

Static files are served by Django via WhiteNoise from `STATIC_ROOT`
(`srv/staticfiles`, `CompressedManifestStaticFilesStorage`), so `/static/`
needs no nginx change (the generic `/` proxy route already reaches `acob-srv`).
The image collects static at build time and the entrypoint re-runs
`collectstatic --noinput` on start, which also covers bind-mounted checkouts.

## Admin

Django admin is enabled at `/admin/` (also reachable through the proxy at
`http://127.0.0.1:<port>/admin/`). It lists `Instruction` rows (id, action,
bid, status, created/updated timestamps with action/status filters and id/bid
search) and
`Reinstall` commands (token, requested time).

Both `make dev` and `make run` (the Docker `CMD`) run
`manage.py ensure_superuser` after migrations. The leading `-` in the
Makefile keeps boot non-failing when the database is unavailable; the
command itself always succeeds with defaults. Override the account with:

```bash
DJANGO_SUPERUSER_USERNAME=admin \
DJANGO_SUPERUSER_EMAIL=admin@example.com \
DJANGO_SUPERUSER_PASSWORD=changeme \
make dev
```

The command is idempotent: it creates the user when missing, otherwise
promotes the existing user to staff/superuser, updates the email, and resets
the password to the env value. When `DJANGO_SUPERUSER_PASSWORD` is unset it
falls back to `changeme` and logs a warning. Change the password later with:

```bash
uv run manage.py changepassword <username>
```

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
the proxy at `http://127.0.0.1:58346` by default. Compose stores media under
`/data` in the project-scoped `srv-data` volume and queue state in Postgres in
the project-scoped `db-data` volume (`acob-srv` depends on healthy `acob-db`). A root
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
host port. A name only distinguishes a user or work context; beyond the
per-browser `bid` target it adds no server protocol routing, and untargeted
work on this server's queue remains claimable by any connected browser.

## API

`GET /api/` returns request-aware links and a queue usage guide. Swagger UI at
`/api/docs/` loads locally packaged assets and presents the Python client
alongside the API; `/api/openapi.json` generates OpenAPI
3.1 from the actual Pydantic request/response models, including the same
client reference. Cross-field validators
are explained in action descriptions. The result envelope remains arbitrary
JSON where the runtime does not enforce a structured result.

Links, the OpenAPI server and curl examples use the current request's scheme,
Host and port, independently of `ACOB_PUBLIC_URL`. nginx preserves Host,
including the port. No documentation is cached across origins. Native HTTPS
requests retain their scheme; the shipped proxy serves HTTP only.

All routes are flat under `/api/` and operate on the one queue for this local
server.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/` | Documentation links and queue usage guide. |
| `GET` | `/api/docs/` | Swagger UI with locally served assets. |
| `GET` | `/api/openapi.json` | Generated OpenAPI 3.1 contract. |
| `POST` | `/api/instructions/` | Validate and enqueue an instruction (optional `bid` target). |
| `POST` | `/api/instructions/batch/` | Enqueue one instruction that runs up to 20 actions sequentially (optional top-level `bid`). |
| `GET` | `/api/instructions/next/?bid=&limit=1` | Claim 1 to 20 pending instructions for the extension (`bid` selects targeted + untargeted work; omitted = untargeted only). |
| `GET` | `/api/instructions/<id>/` | Read status or terminal result (persistent; always includes `bid`). |
| `POST` | `/api/instructions/<id>/result/` | Complete a claimed instruction (executor `bid` in body or `?bid=`). |
| `POST` | `/api/reinstall/` | Queue an unpacked-extension reinstall. |
| `GET` | `/api/reinstall/` | Read the pending reinstall command for manual inspection. |
| `POST` | `/api/reinstall/acknowledge/` | Acknowledge recovery from the new worker. |
| `GET` | `/api/media/<name>` | Serve a stored screenshot, recording, or console capture. |

Supported actions are `list`, `navigate`, `focus`, `close`, `reload`, `scroll`,
`click`, `keyboard`, `screenshot`, `record`, `proxy`, `cleanup`, `console`, and
`javascript`. See the root [API guide](../README.md#api) for payload examples.

Every instruction request accepts an optional `bid` (32 lowercase hex,
`^[0-9a-f]{32}$`); responses always include `bid` (`null` when
untargeted/unclaimed): the target while `pending`, the executor after
`completed`/`failed` (untargeted completions record the claimant's `bid`; a
targeted instruction keeps its target). `next_instructions` with `?bid=` returns
untargeted work plus work targeted at that `bid`; without it, only untargeted
work. Only `PENDING` rows are ever claimable.

`POST /api/instructions/batch/` accepts `{"action": "batch", "actions": [...]}`
with 1 to 20 complete instruction requests. The extension executes the
actions strictly in order and completes the single instruction with one
result or error entry per action; a failed action does not stop the rest of
the batch. Only the batch route accepts the `batch` action, and the result
route validates each entry against its action's result model (screenshots and
recordings are stored through the same local media pipeline per entry).

Instructions persist; they are not trimmed on read. All detail reads are
non-destructive: repeated requests for a `completed` or `failed` instruction
return the same envelope. Only `PENDING` rows are claimable, so terminal work
is never re-gathered.

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
"Allow browser cleanup" popup setting is enabled. The media directory lives on
the local filesystem. The Compose deployment persists media in its
project-scoped `srv-data` volume and queue state in Postgres in `db-data`;
purging those volumes starts with an empty queue and media root.

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

- Postgres (`acob-db`, `db-data` volume) stores the queue in Compose; native
  dev without a configured DB falls back to SQLite at `DATA_DIR/db.sqlite3`.
- `media/` holds screenshots and recordings; any client that can reach the
  server can fetch them from `/api/media/<filename>`.
- `DEBUG` defaults to enabled for native dev (`ACOB_DEBUG`/`DJANGO_DEBUG`);
  Compose sets `ACOB_DEBUG=false`. `ALLOWED_HOSTS` accepts every host by
  default, and the secret key falls back to a committed development value only
  while `DEBUG` is true (production boot without an env secret fails).
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

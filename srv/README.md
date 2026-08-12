# ACOB Server

The server is the Django API and transient SQLite queue for ACOB. API clients
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

Screenshot results require a media storage service. `STORAGE_PROVIDER` selects
the provider (default `chipf`); set `CHIPF_ENDPOINT` and `CHIPF_API_KEY`
(empty by default); without them, screenshot instructions fail with a clear
error instead of storing anything locally.

Create and apply migrations separately with `make migrations` and
`make migrate`.

## Verification

```bash
make check
make test
```

`make check` runs Ruff, Black in check mode, mypy, Pyright, Django's system
checks, and a missing-migration check. `make test` runs the API test suite.
`make format` applies Ruff fixes and Black formatting.

## Docker

The Dockerfile expects this directory to be the build context. From `srv/`, run:

```bash
docker compose up --build
```

From the monorepo root, run:

```bash
docker compose -f srv/compose.yaml up --build
```

The Compose project, service, image, and container are named `acob-srv`. The
service uses the host network, binding `0.0.0.0:58347` directly. The SQLite
database lives inside the container because no volume is configured; removing
or replacing the container removes queued instructions and other database
state.

## API

All routes are scoped by a lowercase dashless UUIDv4 browser ID under
`/api/browsers/<bid>/`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `instructions/` | Validate and enqueue an instruction. |
| `GET` | `instructions/next/?limit=1` | Claim 1 to 20 pending instructions for the extension. |
| `GET` | `instructions/<id>/` | Read status or consume a terminal response. |
| `POST` | `instructions/<id>/result/` | Complete a claimed instruction. |
| `POST` | `reinstall/` | Queue an unpacked-extension reinstall. |
| `GET` | `reinstall/` | Read the pending reinstall command for manual inspection. |
| `POST` | `reinstall/acknowledge/` | Acknowledge recovery from the new worker. |

Supported actions are `list`, `navigate`, `focus`, `close`, `reload`, `scroll`,
`click`, `keyboard`, `screenshot`, and `javascript`. See the root
[API guide](../README.md#api) for payload examples.

Instructions are transport state, not history. Pending and processing reads are
non-destructive. The first successful detail request for a completed or failed
instruction returns its terminal response and deletes the row.

Screenshots are never stored by this server. When the extension reports a
capture, the server immediately uploads the bytes to the configured media
storage service and stores only the resulting public download URL in the
instruction result.

While a reinstall is pending, `instructions/next/` claims no queue work and
instead returns the `reinstall` command directly to the extension; the
extension does not poll the reinstall route separately. The extension persists
the command token, stops active JavaScript work, reloads affected tabs, calls
`chrome.runtime.reload()`, and acknowledges after its new worker starts. The
reinstall request conditionally fails work that is already `processing`, and
the acknowledgement catches any processing race before removing the command.
Pending instructions remain available to the restarted extension.

## Storage And Security

The default configuration is for trusted local development only:

- SQLite stores all queue state in `db.sqlite3`.
- `DEBUG` is enabled, `ALLOWED_HOSTS` accepts every host, and the secret key is
  committed as a development value.
- Queue endpoints have no authentication, and API POST routes are CSRF-exempt.
- ACOB does not provide TLS, rate limiting, expiry cleanup, or tenant isolation.
- Compose publishes the API on all host interfaces by default.

Do not expose this configuration directly to an untrusted network. Review
[`SECURITY.md`](../SECURITY.md) and add authentication, transport security, and
production settings before considering a remote deployment.

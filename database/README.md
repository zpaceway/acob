# ACOB Database

Postgres for the Compose stack. The official `postgres:17` image with no
custom schema — Django owns all tables via `manage.py migrate`.

## Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `ACOB_DATABASE_PORTGRES_DB` | `acob` | Database name (also `ACOB_SRV_DB_NAME` on `acob-srv`) |
| `ACOB_DATABASE_PORTGRES_USER` | `acob` | Role name (also `ACOB_SRV_DB_USER` on `acob-srv`) |
| `ACOB_DATABASE_PORTGRES_PASSWORD` | `acob` | Role password (also `ACOB_SRV_DB_PASSWORD` on `acob-srv`) |

`compose.yaml` maps these to the `POSTGRES_*` variables the official
`postgres:17` image entrypoint requires; set only the `ACOB_*` names.
`acob-srv` connects via `ACOB_SRV_DB_HOST=acob-db` + `ACOB_SRV_DB_PORT=5432`,
or via a single `ACOB_SRV_DATABASE_URL` (e.g.
`postgres://acob:acob@acob-db:5432/acob`). Without either, `acob-srv` falls
back to local SQLite (`DATA_DIR/db.sqlite3`) for dev.

## Local run

From the repo root:

```bash
docker compose config
docker compose up --build acob-db
pg_isready -h 127.0.0.1 -p 5432 -U acob -d acob
```

Data persists in the project-scoped `db-data` volume
(`/var/lib/postgresql/data`). `srv-data` remains for media uploads.

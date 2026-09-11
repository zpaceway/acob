#!/bin/sh
# ACOB srv entrypoint: wait for Postgres (when configured), then migrate
# and collect static files before starting the server (exec "$@").
set -e

resolve_db_target() {
  # Prints "host port" when a postgres DB is configured, else nothing.
  python3 - "$@" <<'PY'
import os
import sys
from urllib.parse import urlparse

url = os.environ.get("ACOB_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
host = os.environ.get("ACOB_DB_HOST", "").strip()
port = os.environ.get("ACOB_DB_PORT", "5432").strip() or "5432"
if url:
    try:
        parsed = urlparse(url)
    except ValueError:
        sys.exit(0)
    if parsed.scheme not in ("postgres", "postgresql", "postgresql+psycopg"):
        sys.exit(0)
    print(f"{parsed.hostname or 'acob-db'} {parsed.port or 5432}")
elif host:
    print(f"{host} {port}")
PY
}

TARGET="$(resolve_db_target "$@")"
if [ -n "$TARGET" ]; then
  DB_HOST="$(printf '%s' "$TARGET" | cut -d' ' -f1)"
  DB_PORT="$(printf '%s' "$TARGET" | cut -d' ' -f2)"
  echo "Waiting for Postgres at ${DB_HOST}:${DB_PORT}..."
  ATTEMPTS=0
  until pg_isready -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -ge 60 ]; then
      echo "error: Postgres at ${DB_HOST}:${DB_PORT} not ready after 60s" >&2
      exit 1
    fi
    sleep 1
  done
  echo "Postgres is ready."
fi

uv run --no-sync manage.py migrate --noinput
uv run --no-sync manage.py collectstatic --noinput
# Default admin for local/testing stacks (idempotent). Non-failing so a DB
# hiccup here never blocks server start.
uv run --no-sync manage.py ensure_superuser || true

exec "$@"

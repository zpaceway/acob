FROM postgres:17

# Default credentials for local Compose development. The supported interface
# is ACOB_DATABASE_PORTGRES_* (see compose.yaml, which maps them to the
# POSTGRES_* variables the official postgres image entrypoint requires).
# These POSTGRES_* defaults only cover standalone image runs.
ENV POSTGRES_DB=acob \
    POSTGRES_USER=acob \
    POSTGRES_PASSWORD=acob

HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
  CMD pg_isready -U "${POSTGRES_USER:-acob}" -d "${POSTGRES_DB:-acob}" || exit 1

VOLUME /var/lib/postgresql/data

EXPOSE 5432

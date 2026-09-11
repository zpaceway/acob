FROM postgres:17

# Default credentials for local Compose development. Override with
# POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD at runtime.
ENV POSTGRES_DB=acob \
    POSTGRES_USER=acob \
    POSTGRES_PASSWORD=acob

HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
  CMD pg_isready -U "${POSTGRES_USER:-acob}" -d "${POSTGRES_DB:-acob}" || exit 1

VOLUME /var/lib/postgresql/data

EXPOSE 5432

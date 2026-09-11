FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

ENV ACOB_SRV_HOST=0.0.0.0 \
    ACOB_SRV_PORT=58347

RUN apt-get update \
    && apt-get install --no-install-recommends -y make postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

COPY . .

# Collect static files at build time so WhiteNoise can serve /static/
# without an nginx change. The entrypoint re-runs it on start (cheap,
# idempotent) to cover bind-mounted source checkouts.
RUN chmod +x docker-entrypoint.sh \
    && uv run --no-sync manage.py collectstatic --noinput

ENTRYPOINT ["./docker-entrypoint.sh"]

CMD ["make", "run"]

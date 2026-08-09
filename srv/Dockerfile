FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

ENV ACOB_SRV_HOST=0.0.0.0 \
    ACOB_SRV_PORT=58347

RUN apt-get update \
    && apt-get install --no-install-recommends -y make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

COPY . .

CMD ["make", "run"]

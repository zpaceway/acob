FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

ENV DEFAULT_ACOB_ENDPOINT=http://host.docker.internal:58347 \
    ACOB_MCP_HOST=0.0.0.0 \
    ACOB_MCP_PORT=58349

RUN apt-get update \
    && apt-get install --no-install-recommends -y make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY client /client
COPY mcp /app
RUN uv sync --locked --no-dev --no-editable

USER 65532:65532

CMD ["make", "run"]

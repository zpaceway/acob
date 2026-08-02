FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

ENV ACOB_MCP_HOST=0.0.0.0 \
    ACOB_MCP_PORT=58349 \
    ACOB_MCP_TRANSPORT=streamable-http

WORKDIR /app

COPY client /client
COPY mcp /app
RUN uv sync --locked --no-dev --no-editable

USER 65532:65532

EXPOSE 58349

ENTRYPOINT ["/app/.venv/bin/acob-mcp"]

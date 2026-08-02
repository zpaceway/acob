MCP_DIST_DIR ?= dist
HOST ?= 127.0.0.1
PORT ?= 58349

.PHONY: format check test build run run-http docker logs

format:
	@echo "Formatting ACOB MCP code..."
	uv run ruff check --fix .
	uv run black src tests

check:
	uv run ruff check .
	uv run black --check src tests
	uv run pyright

test:
	uv run python -m unittest discover -s tests -v

build:
	@echo "Building acob-mcp..."
	uv build --out-dir "$(MCP_DIST_DIR)" --clear
	uvx twine check "$(MCP_DIST_DIR)"/*

run:
	uv run acob-mcp

run-http:
	ACOB_MCP_TRANSPORT=streamable-http ACOB_MCP_HOST=$(HOST) ACOB_MCP_PORT=$(PORT) uv run acob-mcp

docker:
	@echo "Building Docker image..."
	docker compose down --remove-orphans
	docker compose up -d --build

logs:
	docker compose logs --follow acob-mcp

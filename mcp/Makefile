ACOB_MCP_HOST ?= 0.0.0.0
ACOB_MCP_PORT ?= 58348

.PHONY: format check test run docker logs build-push

format:
	@echo "Formatting ACOB MCP code..."
	uv run ruff check --fix .
	uv run black src tests

check:
	uv run ruff check .
	uv run black --check src tests
	uv run mypy --no-incremental src tests
	uv run pyright

test:
	uv run python -m unittest discover -s tests -v

run:
	ACOB_MCP_HOST=$(ACOB_MCP_HOST) ACOB_MCP_PORT=$(ACOB_MCP_PORT) uv run --no-sync python src/server.py

docker:
	@echo "Building Docker image..."
	docker compose down --remove-orphans
	docker compose up -d --build

logs:
	docker compose logs --follow acob-mcp

build-push:
	docker build -t harbor.zpaceway.com/zpaceway/acob-mcp:latest -f ./Dockerfile ..
	docker push harbor.zpaceway.com/zpaceway/acob-mcp:latest

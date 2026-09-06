ACOB_MCP_HOST ?= 0.0.0.0
ACOB_MCP_PORT ?= 58348
ACOB_ENDPOINT ?= http://127.0.0.1:58347

.PHONY: format check test run

format:
	@echo "Formatting ACOB MCP code..."
	uv run ruff check --fix .
	uv run ruff format .

check:
	@echo "Checking ACOB MCP code..."
	uv run ruff check .
	uv run ruff format --check .
	uv run ty check .

test:
	@echo "Running tests..."
	uv run python -m unittest discover -s tests -v

run:
	@echo "Starting ACOB MCP server..."
	ACOB_ENDPOINT=$(ACOB_ENDPOINT) ACOB_MCP_HOST=$(ACOB_MCP_HOST) ACOB_MCP_PORT=$(ACOB_MCP_PORT) uv run --no-sync python -m src.server

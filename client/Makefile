CLIENT_DIST_DIR ?= dist

.PHONY: format check test build publish

format:
	@echo "Formatting Python code..."
	uv run ruff check --fix .
	uv run black acob tests

check:
	@echo "Checking Python code..."
	uv run ruff check .
	uv run black --check acob tests
	uv run mypy --no-incremental acob tests
	uv run pyright

test:
	@echo "Running tests..."
	uv run python -m unittest discover -s tests -v

build:
	@echo "Building acob-client..."
	uv build --out-dir "$(CLIENT_DIST_DIR)" --clear
	uvx twine check "$(CLIENT_DIST_DIR)"/*

publish: build
	@echo "Publishing acob-client..."
	uvx twine upload "$(CLIENT_DIST_DIR)"/*

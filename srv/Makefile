HOST ?= 127.0.0.1
PORT ?= 58347

.PHONY: format check test migrations migrate dev run docker logs

format:
	@echo "Formatting Python code..."
	uv run ruff check --fix .
	uv run black acob api manage.py

check:
	uv run ruff check .
	uv run black --check acob api manage.py
	uv run mypy --no-incremental acob api manage.py
	uv run pyright
	uv run manage.py check
	uv run manage.py makemigrations --check --dry-run

test:
	uv run manage.py test api

migrations:
	@echo "Running migrations..."
	uv run manage.py makemigrations

migrate:
	@echo "Applying migrations..."
	uv run --no-sync manage.py migrate

dev:
	@echo "Starting development server..."
	$(MAKE) migrate
	uv run manage.py runserver $(HOST):$(PORT)

run:
	@echo "Starting ASGI server..."
	$(MAKE) migrate
	uv run --no-sync uvicorn acob.asgi:application --host $(HOST) --port $(PORT)

docker:
	@echo "Building Docker image..."
	docker compose down --remove-orphans
	docker compose up -d --build

logs:
	@echo "Viewing Docker logs..."
	docker compose logs -f

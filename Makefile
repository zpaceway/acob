HOST ?= 127.0.0.1
PORT ?= 58347

migrations:
	@echo "Running migrations..."
	uv run manage.py makemigrations

migrate:
	@echo "Applying migrations..."
	uv run manage.py migrate

dev:
	@echo "Starting development server..."
	uv run manage.py runserver $(HOST):$(PORT)

run:
	@echo "Starting production server..."
	uv run uvicorn acob.asgi:application --host $(HOST) --port $(PORT)

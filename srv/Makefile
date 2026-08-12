ACOB_SRV_HOST ?= 0.0.0.0
ACOB_SRV_PORT ?= 58347
STORAGE_PROVIDER ?= chipf
CHIPF_ENDPOINT ?=
CHIPF_API_KEY ?=

export STORAGE_PROVIDER CHIPF_ENDPOINT CHIPF_API_KEY

.PHONY: format check test migrations migrate dev run docker logs

format:
	@echo "Formatting Python code..."
	uv run ruff check --fix .
	uv run black acob api manage.py

check:
	@echo "Checking Python code..."
	uv run ruff check .
	uv run black --check acob api manage.py
	uv run mypy --no-incremental acob api manage.py
	uv run pyright
	uv run manage.py check
	uv run manage.py makemigrations --check --dry-run

test:
	@echo "Running tests..."
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
	uv run manage.py runserver $(ACOB_SRV_HOST):$(ACOB_SRV_PORT)

run:
	@echo "Starting ASGI server..."
	$(MAKE) migrate
	uv run --no-sync uvicorn acob.asgi:application --host $(ACOB_SRV_HOST) --port $(ACOB_SRV_PORT)

docker:
	@echo "Building Docker image..."
	docker compose down --remove-orphans
	docker compose up -d --build

logs:
	@echo "Viewing Docker logs..."
	docker compose logs -f acob-srv

build-push:
	@echo "Building and pushing Docker image..."
	docker build -t harbor.zpaceway.com/zpaceway/acob-srv:latest .
	docker push harbor.zpaceway.com/zpaceway/acob-srv:latest

deploy:
	@echo "Deploying to Kubernetes..."
	$(MAKE) build-push
	kubectl rollout restart deployment/acob --namespace=acob

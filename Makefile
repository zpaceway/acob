HOST ?= 127.0.0.1
PORT ?= 58347
XDG_CONFIG_HOME ?= $(HOME)/.config
CLIENT_DIST_DIR ?= client/dist

SKILL_NAME := acob
CLAUDE_SKILL_DIR ?= $(HOME)/.claude/skills/$(SKILL_NAME)
OPENCODE_SKILL_DIR ?= $(XDG_CONFIG_HOME)/opencode/skills/$(SKILL_NAME)

.PHONY: format migrations migrate dev run publish-client install-skill-claude install-skill-opencode

format:
	@echo "Formatting Python code..."
	uv run ruff check --fix
	uv run black acob api manage.py
	uv run black --config client/pyproject.toml client/acob client/tests

migrations:
	@echo "Running migrations..."
	uv run manage.py makemigrations

migrate:
	@echo "Applying migrations..."
	uv run manage.py migrate

dev:
	@echo "Starting development server..."
	make migrate
	uv run manage.py runserver $(HOST):$(PORT)

run:
	@echo "Starting production server..."
	make migrate
	uv run uvicorn acob.asgi:application --host $(HOST) --port $(PORT)

docker:
	@echo "Building Docker image..."
	docker compose up -d --build

publish-client:
	@echo "Building and publishing acob-client..."
	uv build client --out-dir "$(CLIENT_DIST_DIR)" --clear
	uvx twine check "$(CLIENT_DIST_DIR)"/*
	uvx twine upload "$(CLIENT_DIST_DIR)"/*

install-skill-claude:
	install -d "$(CLAUDE_SKILL_DIR)"
	install -m 0644 docs/SKILL.md "$(CLAUDE_SKILL_DIR)/SKILL.md"

install-skill-opencode:
	install -d "$(OPENCODE_SKILL_DIR)"
	install -m 0644 docs/SKILL.md "$(OPENCODE_SKILL_DIR)/SKILL.md"

HOST ?= 127.0.0.1
PORT ?= 58347
XDG_CONFIG_HOME ?= $(HOME)/.config

SKILL_NAME := acob
CLAUDE_SKILL_DIR ?= $(HOME)/.claude/skills/$(SKILL_NAME)
OPENCODE_SKILL_DIR ?= $(XDG_CONFIG_HOME)/opencode/skills/$(SKILL_NAME)

.PHONY: migrations migrate dev run install-skill-claude install-skill-opencode

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

install-skill-claude:
	install -d "$(CLAUDE_SKILL_DIR)"
	install -m 0644 SKILL.md "$(CLAUDE_SKILL_DIR)/SKILL.md"

install-skill-opencode:
	install -d "$(OPENCODE_SKILL_DIR)"
	install -m 0644 SKILL.md "$(OPENCODE_SKILL_DIR)/SKILL.md"

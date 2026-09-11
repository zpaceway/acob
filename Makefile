ACOB_PROXY_PORT ?= 58346
ACOB_APPLICATION_NAME ?=
DEFAULT_EXTENSION_PATH := $(CURDIR)/extension/dist
ACOB_EXTENSION_PATH ?= $(DEFAULT_EXTENSION_PATH)
EXTENSION_CONTEXT := $(abspath $(ACOB_EXTENSION_PATH))
INSTANCE := acob-$(ACOB_PROXY_PORT)-$(strip $(ACOB_APPLICATION_NAME))
ACOB_MCP_NAME ?= $(INSTANCE)
ACOB_MCP_URL := http://127.0.0.1:$(ACOB_PROXY_PORT)/mcp
COMPOSE := ACOB_PROXY_PORT=$(ACOB_PROXY_PORT) ACOB_EXTENSION_PATH="$(EXTENSION_CONTEXT)" docker compose --project-name $(INSTANCE) --file compose.yaml
ACOB_OPENCODE_BIN ?= $(shell command -v opencode 2>/dev/null || echo $$HOME/.opencode/bin/opencode)
ACOB_CLAUDE_BIN ?= $(shell command -v claude 2>/dev/null || echo $$HOME/.local/bin/claude)

.PHONY: check-port check-name check-context prepare-extension install up down purge logs ps install-opencode install-claude

check-port:
	@case "$(ACOB_PROXY_PORT)" in ''|*[!0-9]*) echo "error: ACOB_PROXY_PORT must be an integer from 1 to 65535"; exit 1;; esac; \
	test "$(ACOB_PROXY_PORT)" -ge 1 -a "$(ACOB_PROXY_PORT)" -le 65535 || (echo "error: ACOB_PROXY_PORT must be an integer from 1 to 65535"; exit 1)

check-name:
	@case "$(ACOB_APPLICATION_NAME)" in ''|-*|*-|*[!a-z0-9-]*) echo "error: ACOB_APPLICATION_NAME is required and must use lowercase letters, digits, and internal hyphens"; exit 1;; esac

check-context: check-port check-name

prepare-extension:
ifeq ($(EXTENSION_CONTEXT),$(DEFAULT_EXTENSION_PATH))
	ACOB_EXTENSION_BASE_URL=http://acob-proxy $(MAKE) -C extension build
else
	@echo "Using prebuilt browser extension at $(EXTENSION_CONTEXT)"
endif
	@test -f "$(EXTENSION_CONTEXT)/manifest.json" || (echo "error: ACOB_EXTENSION_PATH must contain a built extension with manifest.json"; exit 1)

install: check-context prepare-extension
	@echo "Starting isolated ACOB instance $(INSTANCE)..."
	$(COMPOSE) up --detach --build
	@echo "Managed Chromium is running in the acob-browser container"
	@echo "Browser extension: $(EXTENSION_CONTEXT)"
	@echo "MCP endpoint: $(ACOB_MCP_URL)"

up: check-context prepare-extension
	$(COMPOSE) up --detach --build

down: check-context
	$(COMPOSE) down --remove-orphans

purge: check-context
	$(COMPOSE) down --remove-orphans --volumes

logs: check-context
	$(COMPOSE) logs --follow

ps: check-context
	$(COMPOSE) ps

install-opencode: install
	@test -x "$(ACOB_OPENCODE_BIN)" || (echo "error: opencode CLI not found at $(ACOB_OPENCODE_BIN)"; exit 1)
	"$(ACOB_OPENCODE_BIN)" mcp add "$(ACOB_MCP_NAME)" --url "$(ACOB_MCP_URL)"

install-claude: install
	@test -x "$(ACOB_CLAUDE_BIN)" || (echo "error: claude CLI not found at $(ACOB_CLAUDE_BIN)"; exit 1)
	"$(ACOB_CLAUDE_BIN)" mcp remove -s user "$(ACOB_MCP_NAME)" >/dev/null 2>&1 || true
	"$(ACOB_CLAUDE_BIN)" mcp add --transport http -s user "$(ACOB_MCP_NAME)" "$(ACOB_MCP_URL)"

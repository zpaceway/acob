PORT ?= 58346
NAME ?=
DEFAULT_EXTENSION_PATH := $(CURDIR)/extension/dist
EXTENSION_PATH ?= $(DEFAULT_EXTENSION_PATH)
EXTENSION_CONTEXT := $(abspath $(EXTENSION_PATH))
INSTANCE := acob-$(PORT)-$(strip $(NAME))
MCP_NAME ?= $(INSTANCE)
MCP_URL := http://127.0.0.1:$(PORT)/mcp
COMPOSE := PORT=$(PORT) ACOB_EXTENSION_PATH="$(EXTENSION_CONTEXT)" docker compose --project-name $(INSTANCE) --file compose.yaml
OPENCODE_BIN ?= $(shell command -v opencode 2>/dev/null || echo $$HOME/.opencode/bin/opencode)
CLAUDE_BIN ?= $(shell command -v claude 2>/dev/null || echo $$HOME/.local/bin/claude)

.PHONY: check-port check-name check-context prepare-extension install up down purge logs ps install-opencode install-claude

check-port:
	@case "$(PORT)" in ''|*[!0-9]*) echo "error: PORT must be an integer from 1 to 65535"; exit 1;; esac; \
	test "$(PORT)" -ge 1 -a "$(PORT)" -le 65535 || (echo "error: PORT must be an integer from 1 to 65535"; exit 1)

check-name:
	@case "$(NAME)" in ''|-*|*-|*[!a-z0-9-]*) echo "error: NAME is required and must use lowercase letters, digits, and internal hyphens"; exit 1;; esac

check-context: check-port check-name

prepare-extension:
ifeq ($(EXTENSION_CONTEXT),$(DEFAULT_EXTENSION_PATH))
	ACOB_BASE_URL=http://acob-proxy $(MAKE) -C extension build
else
	@echo "Using prebuilt browser extension at $(EXTENSION_CONTEXT)"
endif
	@test -f "$(EXTENSION_CONTEXT)/manifest.json" || (echo "error: EXTENSION_PATH must contain a built extension with manifest.json"; exit 1)

install: check-context prepare-extension
	@echo "Starting isolated ACOB instance $(INSTANCE)..."
	$(COMPOSE) up --detach --build
	@echo "Managed Chromium is running in the acob-browser container"
	@echo "Browser extension: $(EXTENSION_CONTEXT)"
	@echo "MCP endpoint: $(MCP_URL)"

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
	@test -x "$(OPENCODE_BIN)" || (echo "error: opencode CLI not found at $(OPENCODE_BIN)"; exit 1)
	"$(OPENCODE_BIN)" mcp add "$(MCP_NAME)" --url "$(MCP_URL)"

install-claude: install
	@test -x "$(CLAUDE_BIN)" || (echo "error: claude CLI not found at $(CLAUDE_BIN)"; exit 1)
	"$(CLAUDE_BIN)" mcp remove -s user "$(MCP_NAME)" >/dev/null 2>&1 || true
	"$(CLAUDE_BIN)" mcp add --transport http -s user "$(MCP_NAME)" "$(MCP_URL)"

ACOB_PROXY_PORT ?= 58346
BID ?=
OPENCODE_BIN ?= $(shell command -v opencode 2>/dev/null || echo $$HOME/.opencode/bin/opencode)
CLAUDE_BIN ?= $(shell command -v claude 2>/dev/null || echo $$HOME/.local/bin/claude)
MCP_URL = http://127.0.0.1:$(ACOB_PROXY_PORT)/mcp/$(BID)

.PHONY: docker logs down install-opencode install-claude check-bid

docker:
	@echo "Starting ACOB proxy stack (srv + mcp + nginx)..."
	docker compose up -d --build

logs:
	@echo "Following proxy logs..."
	docker compose logs --follow acob-proxy

down:
	@echo "Stopping ACOB proxy stack..."
	docker compose down --remove-orphans

check-bid:
	@echo "$(BID)" | grep -Eq '^[0-9a-f]{32}$$' || (echo "error: BID must be the 32-character lowercase hex browser ID from the extension popup (e.g. make -C proxy install-opencode BID=0123456789ab4def8123456789abcdef)"; exit 1)

install-opencode: check-bid
	@$(MAKE) docker
	@test -x "$(OPENCODE_BIN)" || (echo "error: opencode CLI not found at $(OPENCODE_BIN); install it or override with OPENCODE_BIN=/path/to/opencode"; exit 1)
	@echo "Registering ACOB MCP server at $(MCP_URL) with opencode..."
	"$(OPENCODE_BIN)" mcp add acob --url "$(MCP_URL)"
	@echo "Done. Restart/reconnect your opencode session so it picks up the new tools."

install-claude: check-bid
	@$(MAKE) docker
	@test -x "$(CLAUDE_BIN)" || (echo "error: claude CLI not found at $(CLAUDE_BIN); install it or override with CLAUDE_BIN=/path/to/claude"; exit 1)
	@echo "Registering ACOB MCP server at $(MCP_URL) with claude (user scope)..."
	"$(CLAUDE_BIN)" mcp remove -s user acob >/dev/null 2>&1 || true
	"$(CLAUDE_BIN)" mcp add --transport http -s user acob "$(MCP_URL)"
	@echo "Done. Start a new Claude Code session to use the acob tools."

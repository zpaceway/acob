ACOB_PROXY_PORT ?= 58346

.PHONY: docker logs down

docker:
	@echo "Starting ACOB proxy stack (srv + mcp + nginx)..."
	docker compose up -d --build

logs:
	@echo "Following proxy logs..."
	docker compose logs --follow acob-proxy

down:
	docker compose down --remove-orphans

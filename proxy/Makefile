PORT ?= 58346
NAME ?=

.PHONY: docker logs down install-opencode install-claude

docker:
	$(MAKE) -C .. up PORT=$(PORT) NAME="$(NAME)"

logs:
	@echo "Following proxy logs..."
	$(MAKE) -C .. logs PORT=$(PORT) NAME="$(NAME)"

down:
	@echo "Stopping ACOB proxy stack..."
	$(MAKE) -C .. down PORT=$(PORT) NAME="$(NAME)"

install-opencode:
	$(MAKE) -C .. install-opencode PORT=$(PORT) NAME="$(NAME)"

install-claude:
	$(MAKE) -C .. install-claude PORT=$(PORT) NAME="$(NAME)"

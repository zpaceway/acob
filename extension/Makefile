.PHONY: install typecheck test build

install:
	@echo "Installing browser extension dependencies..."
	npm ci

typecheck:
	npm run typecheck

test:
	npm test

build:
	@echo "Building browser extension..."
	$(MAKE) install
	npm run build

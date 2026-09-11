.PHONY: install typecheck test build

install:
	@echo "Installing browser extension dependencies..."
	npm ci

typecheck:
	@echo "Type checking browser extension code..."
	npm run typecheck

test:
	@echo "Running browser extension tests..."
	npm test

coverage:
	@echo "Running browser extension tests with coverage..."
	npm run test:coverage

build:
	@echo "Building browser extension..."
	$(MAKE) install
	npm run build

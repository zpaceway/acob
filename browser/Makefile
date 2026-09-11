ACOB_EXTENSION_PATH ?= ../extension/dist
EXTENSION_CONTEXT := $(abspath $(ACOB_EXTENSION_PATH))

.PHONY: check check-extension build

check:
	sh -n entrypoint.sh

check-extension:
	@test -f "$(EXTENSION_CONTEXT)/manifest.json" || (echo "error: ACOB_EXTENSION_PATH must contain a built extension with manifest.json"; exit 1)

build: check check-extension
	docker build --build-context extension="$(EXTENSION_CONTEXT)" --file Dockerfile --tag acob-browser .

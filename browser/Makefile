.PHONY: check build

check:
	sh -n entrypoint.sh

build: check
	docker build --file Dockerfile --tag acob-browser ..

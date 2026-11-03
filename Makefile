VERSION := $(shell node -p "require('./package.json').version")
NAME := $(shell node -p "require('./package.json').name")
VSIX := $(NAME)-$(VERSION).vsix

.DEFAULT_GOAL := help
.PHONY: help deps build typecheck test check package install clean

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

deps: ## Install dependencies without running their scripts
	npm ci --ignore-scripts

build: ## Bundle the extension into dist/
	npm run build

typecheck: ## Check types
	npm run typecheck

test: ## Build and run the tests
	npm test

check: typecheck test ## Check types and run the tests

package: ## Build the installable VSIX
	npm run package

install: package ## Build the VSIX and install it into VS Code; reload the window afterwards
	code --install-extension $(VSIX) --force

clean: ## Remove build output and VSIX files
	rm -rf dist .test-dist *.vsix

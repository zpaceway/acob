XDG_CONFIG_HOME ?= $(HOME)/.config

SKILL_NAME := acob
CLAUDE_SKILL_DIR ?= $(HOME)/.claude/skills/$(SKILL_NAME)
OPENCODE_SKILL_DIR ?= $(XDG_CONFIG_HOME)/opencode/skills/$(SKILL_NAME)

.PHONY: install-skill-claude install-skill-opencode

install-skill-claude:
	install -d "$(CLAUDE_SKILL_DIR)"
	install -m 0644 ./SKILL.md "$(CLAUDE_SKILL_DIR)/SKILL.md"

install-skill-opencode:
	install -d "$(OPENCODE_SKILL_DIR)"
	install -m 0644 ./SKILL.md "$(OPENCODE_SKILL_DIR)/SKILL.md"

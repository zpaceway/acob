# ACOB Documentation

This directory contains project planning and agent integration documents. It
is not a generated documentation website.

| File | Purpose |
| --- | --- |
| [`PLAN.md`](PLAN.md) | Current capabilities, accepted non-goals, and roadmap candidates. |
| [`SKILL.md`](SKILL.md) | Installable instructions for agents that control Chromium through `ACOBClient`. |

## Agent Skill Prerequisites

The skill assumes that:

- The `acob-client` package is installed in the agent's Python environment.
- The ACOB server is reachable, normally at `http://127.0.0.1:58347`.
- The extension is enabled in the target Chromium profile and configured for
  that server.
- The user can provide the browser ID shown in the extension popup.

See the [client](../client/README.md), [server](../srv/README.md), and
[extension](../extension/README.md) documentation for setup.

## Install The Skill

From the monorepo root, install the skill for Claude-compatible agents or
OpenCode:

```bash
make -C docs install-skill-claude
make -C docs install-skill-opencode
```

The targets copy `SKILL.md` to `~/.claude/skills/acob/SKILL.md` or
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/acob/SKILL.md`. Override
`CLAUDE_SKILL_DIR` or `OPENCODE_SKILL_DIR` to install elsewhere, but keep the
destination directory named `acob` so it matches the skill's frontmatter name.
Restart the agent host after installation so it reloads the skill.

## Maintenance

Update `SKILL.md` whenever client methods, API lifecycle behavior, browser
actions, errors, or safety constraints change. Keep examples aligned with
`client/acob/client.py`, `srv/api/schemas.py`, and `extension/src/types.ts`.
Record proposed product work in `PLAN.md`; implemented behavior belongs in the
baseline or completed milestone sections rather than the candidate roadmap.

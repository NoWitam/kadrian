# Claude Code setup for Kadrion

This directory contains project-scoped Claude Code configuration.

## Files

- `../AGENTS.md` — shared project constraints and architecture rules.
- `../CLAUDE.md` — imports `AGENTS.md` for Claude Code compatibility.
- `agents/kadrion-architect.md` — read-only architecture subagent.
- `skills/bootstrap-kadrion/SKILL.md` — reusable `/bootstrap-kadrion` prompt.

## First use

1. Copy all files into the root of the empty Kadrion repository.
2. Start Claude Code from that repository root.
3. Paste the contents of `FIRST_PROMPT.md`, or invoke `/bootstrap-kadrion`.
4. If `.claude/agents/` did not exist when the current Claude Code session
   started, restart the session so the first custom agent is detected.
5. Optionally validate the agent definition:

   ```bash
   claude plugin validate .claude/agents
   ```

The bootstrap skill intentionally creates only PR-00. PR-01 should introduce
the narrow composition schema and first validated fixture in a separate change.


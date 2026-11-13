---
"oi-agent": minor
---

oi now follows the instruction files and skills you keep for other coding agents. At the start of a session it reads the nearest `AGENTS.md`, `AGENT.md` or `CLAUDE.md` (from the working directory up to the repository root, plus `~/.claude/CLAUDE.md` and `~/.config/AGENTS.md`). Skills in `.agents/skills/` and `.claude/skills/`, in the project or your home directory, are listed by description, and a skill is read in full only when a task calls for it. Each read shows up as a tool call in the session's spans.

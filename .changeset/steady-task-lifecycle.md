---
"oi-agent": patch
---

Keep finished task worktrees and branches so follow-up messages can resume in the same directory. Handle failed command spawns without crashing the CLI. Prevent Phoenix-only storage from deleting sessions with outstanding background jobs, task runners, or results arriving during export.

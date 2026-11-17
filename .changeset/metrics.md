---
"oi-agent": minor
---

`/metrics` shows where a session's time went, and `oi metrics [session]` prints the same from the shell (`--json` for all the numbers). Each turn is split into model time and tool time; tool time is grouped by what ran (`pnpm e2e`, `git commit`, `read_file`), the slowest tool calls are listed, and evaluator and learning time is reported apart from the turns. Delegated tasks are listed with their own totals. Everything is computed from the start and end times the span files already hold, so it works on old sessions too.

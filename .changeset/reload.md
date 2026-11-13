---
"oi-agent": minor
---

`/reload` restarts oi on its current code without leaving the session. The `oi` command is now a small launcher that runs the CLI and starts it again when asked to, carrying over the session, model, effort and approval mode. Before restarting, it checks that the new code loads, and keeps the current build running if it does not. If code started by a reload crashes before its terminal comes up, oi falls back to the bundled build on the same session and says why. Run from a checkout with `bin/oi`, this means edits to oi's own sources take effect in place. Also new: `--effort <level>`, and `--check`, which loads every module and exits.

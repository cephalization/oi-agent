---
"oi-agent": patch
---

Fixes found before the release:

- A message queued for the next turn no longer starts after you have left: quitting, `/reload`, `/new` and `/resume` leave it in the session, and it runs when the session is next opened. Before, a message the engine had already picked up could start a turn with nobody at the terminal.
- `oi -c` and `oi metrics` with no session now mean the session you last worked in. They used to take the newest session folder, which was often a delegated task's session or one opened and closed without a prompt.
- During `/compact` and `/handoff` the line under the prompt says Enter queues: those read nothing said to them, so a message sent then was shown as steering and never read.

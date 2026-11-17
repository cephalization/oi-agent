---
"oi-agent": patch
---

Fix replies being cut short, or missing, in a terminal attached to a task (`/attach`, `oi -s <task>`). Text a subagent wrote between two looks at its files was dropped, so a reply could show as its first few characters.

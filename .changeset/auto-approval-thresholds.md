---
"oi-agent": patch
---

Auto approval asks less often: every decision-model threshold is now 0.5 (each risk must be below 0.5, and the call must be requested with probability above 0.5). Hard rules for destructive deletes, force pushes, sudo, discarded work and writes outside the workspace still always ask.

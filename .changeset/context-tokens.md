---
"oi-agent": patch
---

The status bar now shows how full the context is (the latest model request and its reply, for example `140k context`) instead of every model call added up, which counted cached history again on each call and included evaluators. `/session` still reports the running total.

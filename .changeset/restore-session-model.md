---
"oi-agent": minor
---

Switching to a session with `/resume`, or opening one with `oi resume` or `oi -s`, now continues on the model, provider and effort that session last used, read from its spans. An explicit `-m` still wins. If the session's model is no longer available (its provider was removed, or there is no key), oi stays on the current model and says so. New sessions keep the current model.

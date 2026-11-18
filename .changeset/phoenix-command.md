---
"oi-agent": minor
---

`/phoenix` chooses the Phoenix server, project and login while a session runs, and export switches to it at once with no restart; `oi setup` asks the same questions. oi now asks the server what it wants before saving: a Phoenix without auth needs no key, and one that asks for a login offers "Log in with your browser", where you approve oi in Phoenix and it stores a personal API key in your keychain without you seeing or pasting it. Pasting an API key still works, as does pasting the redirect address when the browser cannot reach your machine. `/phoenix` then `none` turns export off.

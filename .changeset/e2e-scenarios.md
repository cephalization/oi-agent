---
"oi-agent": minor
---

- **Point model requests at a proxy:** `OPENAI_BASE_URL` now overrides the API root for the OpenAI and ChatGPT providers, as `ANTHROPIC_BASE_URL` already did for Anthropic.
- **See pending approvals in the trace:** a tool call waiting for you to allow or deny it is now marked `awaiting_approval` on its in-flight `TOOL` span. Viewers and anything else reading the session can tell it apart from a tool that is running.
- **A bad value in `config.json` no longer resets everything:** a value oi does not accept (a typo, or a setting from a newer version) used to make it ignore the whole file silently, so every setting went back to its default, model included. Now only that key is ignored, and oi says which one, under the banner or on stderr for `oi run`.

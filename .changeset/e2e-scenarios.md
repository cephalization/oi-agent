---
"oi-agent": minor
---

- **Point model requests at a proxy:** `OPENAI_BASE_URL` now overrides the API root for the OpenAI and ChatGPT providers, as `ANTHROPIC_BASE_URL` already did for Anthropic.
- **See pending approvals in the trace:** a tool call waiting for you to allow or deny it is now marked `awaiting_approval` on its in-flight `TOOL` span. Viewers and anything else reading the session can tell it apart from a tool that is running.

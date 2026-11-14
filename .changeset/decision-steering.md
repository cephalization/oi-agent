---
"oi-agent": minor
---

Configure which provider and model learns from your corrections, including ChatGPT and OpenAI-compatible servers without an Anthropic key. Setup offers the choice.

Add System One-compatible decision models (TypeSafe Jev) for auto-mode tool approvals and cheap steering screens. Auto mode approves only confident, low-risk calls and asks about the rest; missing keys, invalid answers and service failures fall back to asking. Configure the endpoint and model independently of chat providers, store its key with `oi auth login typesafe` or `/provider`, and inspect each call as a `DECISION` span with separate usage.

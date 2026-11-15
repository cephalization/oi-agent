---
"oi-agent": minor
---

Call OpenAI and ChatGPT models over a WebSocket so the prompt cache is reused between calls. Over plain HTTP most calls on a ChatGPT plan read nothing from the cache; with one connection per conversation, calls after the first read most of the prompt from it, which lowers plan usage and latency in long sessions. oi falls back to HTTP when a socket cannot be opened, and `OI_AGENT_OPENAI_TRANSPORT=http` turns the WebSocket off. `LLM` spans now record the transport as `network.protocol.name`, and cache writes reported by OpenAI as `llm.token_count.prompt_details.cache_write`.

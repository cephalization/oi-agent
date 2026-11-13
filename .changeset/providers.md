---
"oi-agent": minor
---

oi-agent now runs on OpenAI and OpenAI-compatible APIs, not only Anthropic's.

- **Pick any provider's model:** `/model` lists every provider's models (`anthropic/claude-opus-5-5`, `openai/gpt-5.1`, `ollama/qwen3`, …), and `-m provider/model` does the same from the command line. You can switch provider in the middle of a session: the conversation carries over as text, tool calls and tool results.
- **Manage providers with `/provider`:** it lists each provider and its status. `/provider add <id> <base-url>` adds an OpenAI-compatible server such as Ollama, vLLM, LM Studio or OpenRouter, and asks for its key. Keys are typed into a hidden prompt and stored in the system keychain, as Anthropic keys are. `/provider key <id>` replaces a key, and `/provider remove <id>` removes a server.
- **Sign in with ChatGPT:** `/provider login` (or `oi auth login chatgpt`) signs in with your ChatGPT plan in the browser, so you can use the plan's allowance instead of an API key. OpenAI allows this for open-source tools that run locally.
- **Setup:** `oi setup` now starts by asking which provider to use, and `oi auth login <provider>` stores a key for any provider.

Claude subscriptions are not supported, because Anthropic does not allow third-party tools to offer claude.ai login. Evaluators still judge with Claude, so they run only when an Anthropic key is set.

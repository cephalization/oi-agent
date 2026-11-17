---
"oi-agent": patch
---

`LLM` spans now say who served a call and how it was paid for. `llm.provider` is the vendor (`openai` for both an OpenAI API key and the ChatGPT plan sign-in, where it used to say `chatgpt`), oi's own provider id stays in `metadata.oi_agent.provider`, and a new `metadata.oi_agent.billing` is `plan` for ChatGPT-plan calls and `api` otherwise, so plan usage can be told apart from per-token spend in Phoenix. An OpenAI-compatible provider entry can declare a `vendor` (for example `"groq"`). Evaluator judge spans no longer put a provider id in `llm.system`.

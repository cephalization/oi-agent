---
"oi-agent": minor
---

The agent can now search the web on Anthropic, OpenAI and ChatGPT models, and read a page on Anthropic models, using the provider's own web tools. They run on the provider's servers, so nothing is fetched from your machine and no approval is asked; the provider bills searches separately. Set `"web": "off"` in the config, or `OI_AGENT_WEB=off`, to stop offering them. Other OpenAI-compatible servers are unchanged.

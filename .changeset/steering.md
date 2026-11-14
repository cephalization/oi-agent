---
"oi-agent": minor
---

oi learns from your corrections. After each turn a small model (the judge model, which needs an Anthropic key) reads your prompt, and when it corrects the agent in a way that applies beyond the current task, oi saves it as an evaluator, with a note under the turn and a link back to the prompt it came from. Corrections that only concern the task at hand are left alone. Turn it off with `"steering": "off"` in the config or `OI_AGENT_STEERING=off`. Also fixed: an evaluator created with `create_eval` could fail on the turn that created it, because its own definition contained the pattern it checks for.

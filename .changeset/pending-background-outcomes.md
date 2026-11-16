---
"oi-agent": minor
---

Add opt-in `wait_for_background` to LLM evaluators for outcome-dependent checks. They remain pending without failure feedback or learning until directly launched jobs/tasks deliver results, then review the original launch and delivered outcomes. Immediate launch checks remain the default, and pending verdicts are not counted as passes.

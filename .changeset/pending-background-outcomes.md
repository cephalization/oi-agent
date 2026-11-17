---
"oi-agent": minor
---

Evaluators understand work that finishes later. An LLM evaluator sees which background commands and tasks a turn started and which results it was given, so reporting on earlier work is not mistaken for starting it again. A new opt-in, `wait_for_background: true`, is for checks that depend on the outcome ("the tests it started must pass"): the turn that starts the work is marked `pending`, with no failure feedback and nothing learned from it, and is judged once the results have been delivered, polled with `job_status`, or the work was cancelled. Pending results are not counted as passes. Checks without the option still run at once, which is what a rule about starting work wants.

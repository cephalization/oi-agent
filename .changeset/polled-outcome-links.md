---
"oi-agent": patch
---

Resolve pending outcome evaluations when jobs are observed through `job_status` or stopped with `job_kill`, without duplicate automatic results. Completion links are persisted before claiming results so interrupted observations recover from the inbox. Task cancellation and follow-up messages that start a new runner also carry outcome provenance.

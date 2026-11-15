---
"oi-agent": minor
---

Add `/compact [focus]` to summarize a thread's context without changing its historical spans. Compaction is traced with explicit checkpoint provenance, survives resume from disk or Phoenix, and retains the original context if summarization fails or is interrupted.

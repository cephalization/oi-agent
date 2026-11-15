---
"oi-agent": patch
---

Repair handoffs interrupted between destination header creation and seed completion, using the source's durable spans without rerunning summarization. Initialize pending handoffs before ordinary queued or inbox prompts so the original query and brief cannot be bypassed.

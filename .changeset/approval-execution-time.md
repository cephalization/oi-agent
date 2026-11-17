---
"oi-agent": patch
---

Exclude time waiting for tool approval (including automatic safety decisions) from displayed tool durations and tool execution metrics. Denied calls count as zero execution time; turn wall time and full tool span latency still include approval. Historical spans without an execution boundary retain their original inclusive timing.

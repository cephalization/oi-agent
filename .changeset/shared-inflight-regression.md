---
"oi-agent": patch
---

Fix `oi join` crashing against hosts started on an older version. Drivers and viewers can still follow the conversation; a startup note explains when the host must be updated and restarted to publish live task status. Invalid host responses now produce descriptive errors. Protect existing and newly started task visibility without granting task control or tool approvals.

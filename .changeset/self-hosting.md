---
"oi-agent": patch
---

The bash tool now says when it killed a command for running past its time limit, and how to give the command longer, instead of leaving the model to read the kill as a failure. Commands it runs see `OI_AGENT=1`, so scripts can tell they run under oi.

---
"oi-agent": patch
---

A message you give to a running turn now counts as something you said for everything that reads the turn. Before, only the agent saw it: auto approvals decided later tool calls against the original prompt alone, evaluators judged a transcript without it, and a correction given mid-turn ("no, use pnpm") was never considered for learning. Now the approval decider sees it from the next tool call on, evaluators see it where it was said, and steering detection reads each mid-turn message on its own.

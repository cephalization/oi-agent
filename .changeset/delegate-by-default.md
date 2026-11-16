---
"oi-agent": minor
---

oi now delegates by default. The conversation stays open for thinking and planning while subagents do the work: the agent writes a brief and hands it to another oi agent with its own session, and for anything that changes files its own git worktree and branch, so tasks run side by side without colliding with each other or your checkout.

- Running tasks and background commands are listed above the status line, with what each is doing.
- Results come back by themselves. If you are typing, they wait (`✉ 1 result waiting`) until you send or clear your prompt; `/inbox` delivers them now. Several arrive as one digest.
- A tool call a subagent needs approved is asked in your terminal, labelled with the task.
- `/tasks` lists them, `/attach <task>` opens one to watch and type to, `/detach` returns. You can also ask the agent to steer or cancel a task.
- Tasks keep running when you quit or `/reload`; what finished meanwhile is delivered when you return.
- New config: `cheap_model` (the model for mechanical tasks) and `max_tasks` (how many run at once, default 4).

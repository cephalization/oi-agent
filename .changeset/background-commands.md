---
"oi-agent": minor
---

Long commands no longer die at the tool timeout. A `bash` command that is still running after its time limit keeps going as a background job, and the agent can start one that way on purpose (test suites, builds, servers). You can keep talking while it runs: the status line counts running jobs, and when one finishes its result is delivered to the agent, which picks the work back up. Jobs survive `/reload` and quitting oi; results that arrive while you are away are delivered when you reopen the session. `oi run` waits for the jobs it started (`--no-wait` to skip that).

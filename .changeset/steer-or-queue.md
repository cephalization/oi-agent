---
"oi-agent": minor
---

The terminal now says what Enter will do, and lets you choose. Under the prompt: `enter starts a new turn` when the conversation is idle, including while tasks and background commands are still running. While a turn runs, Enter **steers** it: the agent reads your message before its next step, in the same turn, instead of after it has finished. Press ctrl+t to switch to **queueing** the message for the next turn, and again to switch back. Messages that are waiting are listed above the status line, a steering message is shown in the transcript where the agent was given it, and if a turn ends before it could be steered the message runs as the next turn and the terminal says so. Queued messages are kept on disk, so quitting does not lose them.

---
"oi-agent": minor
---

Resume any session traced to Phoenix, on any machine: `oi resume <session id>`, or paste a session URL from the Phoenix UI. A trace URL continues from that turn instead, forking the session there. The `/resume` list now includes the sessions in your Phoenix project.

Sessions can also live only in Phoenix to save disk space: press Tab on one in the `/resume` list. Its local files are deleted only once Phoenix is confirmed to hold all of it. Opening it fetches it again, and leaving moves it back out. Tab again keeps it on disk.

A session from another machine opens with tools asking before they run, even with `--yolo`. If your checkout differs from the one the session last ran in, oi tells you when it opens. Each turn now records its directory, git remote, commit and whether there were uncommitted changes.

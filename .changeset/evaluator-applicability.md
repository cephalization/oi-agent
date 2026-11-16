---
"oi-agent": minor
---

Evaluators now say when they apply. `create_eval` and checks learned from your corrections record a trigger (file changes, a Git commit, a particular tool, or every turn), shown when the check is saved. A turn the check does not apply to is recorded as `skipped`, without a judge call and without feedback or a learned rule. Commits and file changes are detected from what Git and the files actually did, so a commit made from bash counts and a failed one does not. When the evidence is unclear the check runs. A failed check is rechecked on the next turn even if that turn makes no new commit, so opening the missing PR resolves it. Existing checks keep running on every turn.

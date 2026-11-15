---
"oi-agent": minor
---

Report working, approval-blocked, completed and failed states to terminals that support OSC 7501, including Rex. Interactive sessions acknowledge results on the next keypress and clear status on exit; `oi run` leaves its completion status visible. Status messages are secret-scrubbed, and redirected stdout is unchanged.

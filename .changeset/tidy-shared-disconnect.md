---
"oi-agent": patch
---

Exit joined chats with a clear host-disconnected message when sharing ends or the transport stops responding. Close the host event stream before stopping its tunnel, and cancel pending prompts on disconnect instead of hanging or reporting an unhandled fetch error.

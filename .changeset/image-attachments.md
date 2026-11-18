---
"oi-agent": minor
---

Attach images to a prompt. Drop image files (PNG, JPEG, GIF or WebP) on the terminal, press ctrl+v to paste one from the clipboard, or use `/image <path>`; what is attached is listed above the prompt and goes with your next message, and Backspace at the start of the line removes the last one. `oi run --image <file>` does the same without a terminal. Images are kept in the session, so resuming, switching provider and sharing do not depend on the original files, and someone who joined with a drive link can send images to the host. oi does not check whether a model can read images: a model that cannot says so through its provider's error, and you can switch to one that can with `/model`.

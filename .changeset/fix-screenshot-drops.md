---
"oi-agent": patch
---

Fix dragging macOS screenshots into the terminal when their filenames contain a narrow no-break space. Pressing Enter immediately after a drop now sends the image, even without a text prompt. If a recognized drop fails to attach, oi shows the error and keeps the draft instead of sending it without the image.

// A paste (opaque until its end marker), a CSI, an Alt key, a run of text, or one control key.
// A trailing CSI prefix is saved for the next read. A bare Esc is still a legacy Escape key.
const EVENTS =
  // oxlint-disable-next-line no-control-regex
  /\u001B\[200~[\s\S]*?(\u001B\[201~|$)|\u001B\[[0-?]*[ -/]*[@-~]|(\u001B\[[0-?]*[ -/]*$)|\u001B[^\u001B]|[^\u0000-\u001F\u007F]+|[\s\S]/gu

/** Separate stdin reads into events before interpreting shortcuts or changing input modes. */
export class TerminalInput {
  private pending = ""

  feed(chunk: string): Array<string> {
    const data = this.pending + chunk
    const events: Array<string> = []

    this.pending = ""

    for (const [event, pasteEnd, partialCsi] of data.matchAll(EVENTS)) {
      if (pasteEnd === "" || partialCsi !== undefined) {
        this.pending = event
        break
      }

      events.push(event)
    }

    return events
  }
}

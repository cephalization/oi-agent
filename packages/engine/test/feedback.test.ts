import { describe, expect, it } from "vite-plus/test"
import { feedbackDraft, scrubFeedback } from "../src/feedback.ts"

describe("feedback draft", () => {
  it("previews a title and body and appends only the allowlisted runtime fields", () => {
    expect(feedbackDraft("Title: Menu freezes\nBody:\nOpen the slash menu twice.")).toBe(
      `Title: Menu freezes\nBody:\nOpen the slash menu twice.\n\nRuntime: Node.js ${process.version} · ${process.platform}/${process.arch}`,
    )
  })

  it("normalizes alternate spacing into the same preview format", () => {
    expect(feedbackDraft("Title: Menu freezes\n\nBody: Open the menu twice.")).toMatch(
      /^Title: Menu freezes\nBody:\nOpen the menu twice\./,
    )
  })

  it("removes obvious email addresses and home paths", () => {
    expect(scrubFeedback("alice@example.test, /Users/alice/report.txt; C:\\Users\\Alice\\report.txt")).toBe(
      "[email removed], [path removed]; [path removed]",
    )
    expect(feedbackDraft("Title: Menu freezes\nBody:\nSee alice@example.test")).not.toContain("alice")
  })

  it.each(["\u001b[2J", "\u202E", "\r", "\u0000"])("rejects terminal or display controls: %j", (control) => {
    expect(feedbackDraft(`Title: Menu freezes\nBody:\nDo${control} not post`)).toBeUndefined()
  })

  it.each(["free-form text", "Title: \nBody:\nText", "Title: Missing body\nBody:\n"])(
    "rejects malformed or incomplete previews: %s",
    (reply) => expect(feedbackDraft(reply)).toBeUndefined(),
  )
})

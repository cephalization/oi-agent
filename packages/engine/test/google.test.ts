import { expect, it } from "vite-plus/test"
import { googleGenerateContent, INTERRUPTED_RESULT, type Transcript } from "../src/index.ts"

it("translates images and parallel tool calls without inventing native signatures", () => {
  const history: Transcript = [
    { role: "user", text: "Read both files", images: [{ media_type: "image/png", data: "cG5n" }] },
    {
      role: "assistant",
      text: "",
      calls: [
        { id: "a", name: "read_file", input: { path: "a.txt" } },
        { id: "b", name: "read_file", input: { path: "b.txt" } },
      ],
    },
    { role: "tool", id: "a", output: "A", isError: false },
    { role: "tool", id: "b", output: "File not found", isError: true },
  ]

  const contents = googleGenerateContent.fromTranscript(history)

  expect(contents[1]).toEqual({
    role: "model",
    parts: [
      {
        functionCall: { id: "a", name: "read_file", args: { path: "a.txt" } },
        thoughtSignature: "skip_thought_signature_validator",
      },
      { functionCall: { id: "b", name: "read_file", args: { path: "b.txt" } } },
    ],
  })
  expect(googleGenerateContent.toTranscript(contents)).toEqual(history)
})

it("answers every native function call in order, even if a result was interrupted", () => {
  const content = {
    role: "model",
    parts: [
      { functionCall: { id: "a", name: "read_file", args: { path: "a.txt" } }, thoughtSignature: "c2lnbmVk" },
      { functionCall: { id: "b", name: "read_file", args: { path: "b.txt" } } },
    ],
  }

  const raw = JSON.stringify({ candidates: [{ content, finishReason: "STOP" }] })

  expect(googleGenerateContent.continueWith([], raw, [{ id: "b", output: "B", isError: false }])).toEqual([
    content,
    {
      role: "user",
      parts: [
        { functionResponse: { id: "a", name: "read_file", response: { error: INTERRUPTED_RESULT } } },
        { functionResponse: { id: "b", name: "read_file", response: { output: "B" } } },
      ],
    },
  ])
})

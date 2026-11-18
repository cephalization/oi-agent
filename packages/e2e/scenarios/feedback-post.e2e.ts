import * as fs from "node:fs"
import * as path from "node:path"
import type { Schema } from "effect"
import { afterAll, expect } from "vite-plus/test"
import { fakeChatModel } from "../src/fakes.ts"
import { scenario } from "../src/scenario.ts"

// Deliberately include shell-significant punctuation and Markdown in the literal preview.
const TITLE = '--literal "quotes" $(echo should-not-run)'
const BODY = "First **literal** line.\nSecond line with `backticks` and $HOME."
const URL = "https://github.com/cephalization/oi-agent/issues/900000001"
const model = await fakeChatModel(`Title: ${TITLE}\nBody:\n${BODY}`)

afterAll(() => model.close())

scenario(
  "feedback posts the exact preview only after explicit local consent",
  {
    needs: ["rex"],
    model: "fake/draft",
    config: new Map<string, Schema.Json>([
      ["steering", "off"],
      [
        "providers",
        [
          {
            id: "fake",
            name: "Fake",
            kind: "openai-compatible",
            base_url: model.url,
            models: [{ id: "draft" }],
          },
        ],
      ],
    ]),
  },
  async ({ tui, sandbox, spans }) => {
    const bin = path.join(sandbox.root, "fake-bin")
    const gh = path.join(bin, "gh")
    const log = path.join(bin, "calls")
    const mode = path.join(bin, "mode")

    fs.mkdirSync(bin)
    fs.writeFileSync(
      gh,
      `#!/bin/sh
printf '%s\\0' "$GH_PROMPT_DISABLED" "$@" >> "$GH_TEST_LOG"
read -r mode < "$GH_TEST_MODE"
case "$mode" in
  ok) printf '%s\\n' '${URL}' ;;
  auth) printf '%s\\n' 'private auth details' >&2; exit 4 ;;
  bad-url) printf '%s\\n' 'https://example.test/issue/1' ;;
esac
`,
      { mode: 0o755 },
    )
    fs.writeFileSync(mode, "ok\n")

    // No directory containing real gh is on PATH, including the missing-gh case.
    const term = await tui(["--yolo"], {
      env: new Map([
        ["PATH", bin],
        ["GH_TEST_LOG", log],
        ["GH_TEST_MODE", mode],
      ]),
    })

    const args = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\0").slice(0, -1) : [])

    const begin = async () => {
      await term.line("/feedback Repro for consent test")
      await term.waitFor(/Type POST to publish this preview/)
    }

    await term.waitFor(/^›\s*$/m)
    await begin()

    const screen = await term.screen()

    expect(screen).toContain(`Title: ${TITLE}\nBody:\n${BODY}`)
    expect(screen).toContain("Public issue destination: https://github.com/cephalization/oi-agent/issues")
    expect(args()).toEqual([])
    await term.key("enter")
    await term.waitFor(/Not posted/)
    expect(args()).toEqual([])

    await begin()
    await term.key("esc")
    await term.waitFor(/^›\s*$/m)
    expect(args()).toEqual([])

    await begin()
    expect(args()).toEqual([])
    await term.line("POST")
    await term.waitFor(/Issue posted: .*\/900000001/)

    const session = spans.onlySession()
    const runtime = spans.turns(session)[2]?.output?.split("\n").at(-1)

    const expected = [
      "1",
      "issue",
      "create",
      "--repo=github.com/cephalization/oi-agent",
      `--title=${TITLE}`,
      `--body=${BODY}\n\n${runtime}`,
    ]

    expect(runtime).toMatch(/^Runtime: Node\.js /)
    expect(args()).toEqual(expected)
    expect(spans.tools(session)).toEqual([])
    await term.key("enter")

    fs.writeFileSync(mode, "auth\n")
    await begin()
    expect(args()).toEqual(expected)
    await term.line("POST")

    const failure = await term.waitFor(/check GitHub before retrying/i)

    expect(failure).toContain("To file manually, open https://github.com/cephalization/oi-agent/issues")
    expect(failure).not.toContain("private auth details")
    expect(args()).toEqual([...expected, ...expected])

    fs.writeFileSync(mode, "bad-url\n")
    await begin()
    await term.line("POST")
    await spans.waitFor("second unconfirmed posting", async () => {
      const screen = await term.screen()

      return (screen.match(/Could not confirm posting with gh/g) ?? []).length === 2 ? true : undefined
    })
    expect(args()).toEqual([...expected, ...expected, ...expected])
    expect(await term.screen()).not.toContain("https://example.test/issue/1")

    fs.unlinkSync(gh)
    await begin()
    await term.line("POST")

    const missing = await term.waitFor(/GitHub CLI \(gh\) was not found/)

    expect(missing).toContain("To file manually, open https://github.com/cephalization/oi-agent/issues")
    expect(args()).toEqual([...expected, ...expected, ...expected])
    expect(missing.match(/Issue posted:/g) ?? []).toHaveLength(1)
  },
)

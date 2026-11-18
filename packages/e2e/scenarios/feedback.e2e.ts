import * as fs from "node:fs"
import * as path from "node:path"
import { OI, readMetadata } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { scenario } from "../src/scenario.ts"

scenario(
  "feedback previews a scrubbed issue without giving the model tools or session history",
  { needs: ["rex"], config: new Map([["steering", "off"]]) },
  async ({ tui, spans, sandbox }) => {
    // No real gh can be invoked by this scenario, even on a consent regression.
    // Keep the provider's keychain lookup working with that restricted PATH.
    const keychain = process.platform === "darwin" ? "security" : "secret-tool"

    const lookup = (sandbox.env().get("PATH") ?? "")
      .split(path.delimiter)
      .filter(path.isAbsolute)
      .map((dir) => path.join(dir, keychain))
      .find(fs.existsSync)

    if (lookup !== undefined) fs.symlinkSync(lookup, path.join(sandbox.tmp, keychain))

    const env = new Map([["PATH", sandbox.tmp]])
    const term = await tui(["--yolo"], { env })

    await term.waitFor(/^›\s*$/m)
    await term.line("/feedback")
    await term.waitFor(/issues/)
    await term.line("/share local")
    const shared = await term.waitFor(/View \(read-only\)/)
    const links = [...shared.matchAll(/oi join (oi-share:\S+)/g)]

    expect(links).toHaveLength(2)

    for (const [index, link] of links.entries()) {
      const peer = await tui(["join", link[1] ?? ""], {
        env: new Map([...env, ["OI_AGENT_HOME", path.join(sandbox.root, `feedback-peer-${index}`)]]),
      })

      await peer.waitFor(/joined .*session as/)
      await peer.line("/feedback Do not post")
      await peer.waitFor(/Only the host can run \/feedback/)
      await peer.line("/quit")
      expect(await peer.exited()).toBe(0)
    }

    await term.line("/feedback This must stay local")
    await term.waitFor(/Drafting feedback requires an unshared session/)
    await term.line("/unshare")
    await term.waitFor(/Sharing stopped/)

    const session = spans.onlySession()

    expect(spans.turns(session)).toHaveLength(0)
    await term.line("Reply with the word prior-history-marker")
    await spans.settledTurns(session, 1)
    await term.line(
      "/feedback The slash menu freezes after opening twice. My file is /Users/alice/private.txt and my email is alice@example.test.",
    )
    await spans.settledTurns(session, 2)

    const draft = spans.turns(session)[1]
    const request = spans.ofKind(session, "LLM").at(-1)?.attributes[OI.INPUT_VALUE]

    expect(draft && readMetadata(draft.root).operation).toBe("feedback")
    expect(request).toContain("slash menu freezes")
    expect(request).not.toContain("prior-history-marker")
    expect(request).not.toMatch(/alice|private\.txt|"name":"bash"|"type":"web_search"/)
    expect(draft?.state).toBe("complete")
    expect(draft?.output).toMatch(/Title: .+\nBody:/)
    expect(draft?.output).toMatch(/slash/i)
    expect(draft?.output).not.toMatch(/alice|private\.txt/)
    expect(draft?.output).toContain(`Node.js ${process.version}`)
    expect(draft?.output).toContain(`${process.platform}/${process.arch}`)
    expect(spans.tools(session)).toEqual([])
    await term.waitFor(/github\.com\/cephalization\/oi-agent\/issues/)
    await term.waitFor(/Title: .+\nBody:/)
    await term.waitFor(/Type POST to publish/, 10_000)
    await term.key("esc")
    await term.waitFor(/Not posted/)
    await term.line("Reply with just: resumed")
    await spans.settledTurns(session, 3)

    const resumed = spans.ofKind(session, "LLM").at(-1)?.attributes[OI.INPUT_VALUE]

    expect(resumed).toContain("prior-history-marker")
    expect(resumed).not.toContain("slash menu freezes")
  },
)

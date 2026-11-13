/**
 * Measures what self-contained spans cost on a long session: bytes on disk
 * and the time to derive the next request from them.
 *
 *   node packages/engine/bench/resume.ts [turns] [toolOutputBytes]
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { approveAll, runTurn } from "../src/agent.ts"
import { contextFor, loadSession } from "../src/fold.ts"
import { scriptedModel } from "../src/model.ts"
import { Redactor } from "../src/redact.ts"
import { Store } from "../src/store.ts"
import { defineTool, ok } from "../src/tools.ts"
import { Schema } from "effect"

const turns = Number(process.argv[2] ?? 100)
const outputBytes = Number(process.argv[3] ?? 4000)
const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-bench-")))
const session = store.createSession(os.tmpdir())

const filler = defineTool({
  name: "filler",
  description: "Returns a fixed amount of text.",
  parameters: { type: "object", properties: {} },
  mutates: false,
  input: Schema.Struct({}),
  run: () => Effect.succeed(ok("x".repeat(outputBytes))),
})

const env = { store, sessionId: session.id, cwd: os.tmpdir(), tools: [filler], redactor: new Redactor() }

const model = scriptedModel((_call, step) =>
  step % 2 === 0
    ? {
        content: [{ type: "tool_use", id: `toolu_${step}`, name: "filler", input: {} }],
        stop_reason: "tool_use",
      }
    : { content: [{ type: "text", text: "A short answer to the question." }], stop_reason: "end_turn" },
)

const dirSize = (dir: string): number =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((sum, entry) => sum + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0)

interface Timed<A> {
  readonly value: A
  readonly ms: number
}

const time = <A>(run: () => A): Timed<A> => {
  const start = performance.now()
  const value = run()

  return { value, ms: performance.now() - start }
}

const started = performance.now()

for (let index = 0; index < turns; index += 1) {
  const head = loadSession(store, session.id).head

  await Effect.runPromise(
    runTurn(env, {
      text: `Question ${index}`,
      userId: "bench",
      previous: head === undefined ? null : { trace_id: head.trace_id, span_id: head.root.context.span_id },
    }).pipe(Effect.provide(Layer.mergeAll(model, approveAll))),
  )
}

const wrote = performance.now() - started
const list = time(() => loadSession(store, session.id))
const fold = time(() => contextFor(store, session.id, list.value.head?.trace_id ?? ""))
const bytes = dirSize(store.sessionDir(session.id))
const context = JSON.stringify(fold.value).length

process.stdout.write(
  [
    `turns                 ${turns} (2 model calls and 1 tool call each, ${outputBytes} B tool output)`,
    `span files            ${store.manifest(session.id).length - 1}`,
    `session on disk       ${(bytes / 1e6).toFixed(1)} MB`,
    `final context         ${(context / 1e3).toFixed(0)} kB`,
    `disk / final context  ${(bytes / context).toFixed(0)}x`,
    `write all turns       ${wrote.toFixed(0)} ms (${(wrote / turns).toFixed(1)} ms per turn)`,
    `list turns            ${list.ms.toFixed(1)} ms`,
    `derive next request   ${fold.ms.toFixed(1)} ms`,
    "",
  ].join("\n"),
)

fs.rmSync(store.home, { recursive: true })

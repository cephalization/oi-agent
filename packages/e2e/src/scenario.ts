/**
 * `scenario()` wraps a Vitest test with everything an end-to-end run needs:
 * a sandbox, the model proxy, span queries, terminals in Rex, skip rules
 * for missing prerequisites, a failure message that includes the session
 * outline and the last screen, and cleanup.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { getSecret, nowNs } from "@oi-agent/engine"
import type { Schema } from "effect"
import { it } from "vite-plus/test"
import { withLock } from "./lock.ts"
import {
  PHOENIX_AUTH_ENDPOINT,
  PHOENIX_ENDPOINT,
  PHOENIX_PROJECT,
  phoenixAuthUp,
  phoenixUp,
  reportScenario,
} from "./phoenix.ts"
import { ModelProxy, modelsMode } from "./proxy.ts"
import { canConfine, type RunResult, Sandbox, type SandboxConfig, type SandboxOptions } from "./sandbox.ts"
import { mapSamples, positiveInteger } from "./samples.ts"
import { Spans } from "./spans.ts"
import { findRex, RexTerminal, type Terminal, tail } from "./term.ts"

const MODE = modelsMode()

/**
 * The cheap, fast models scenarios run on: `main` for everything, `second`
 * on the other dialect for switching between providers, and `anthropic` for
 * what only Anthropic offers. Replay serves the ChatGPT model as `openai/`,
 * because a ChatGPT sign-in cannot be faked; the cassette is the same.
 */
export const MODELS = {
  main: process.env["OI_E2E_MODEL"] ?? (MODE === "replay" ? "openai/gpt-5.6-luna" : "chatgpt/gpt-5.6-luna"),
  second: process.env["OI_E2E_SECOND_MODEL"] ?? "anthropic/claude-haiku-5-5",
  anthropic: process.env["OI_E2E_ANTHROPIC_MODEL"] ?? "anthropic/claude-haiku-5-5",
}

/** Prerequisites beyond the scenario's own model, which is always checked. */
export type Need = "rex" | "phoenix" | "phoenix-auth" | "second-model" | "typesafe"

export interface ScenarioOptions {
  /** Fixture repo to work in (`fixtures/repos/<name>`). */
  readonly fixture?: string
  /** `provider/model` written to the sandbox config. */
  readonly model?: string
  readonly effort?: SandboxConfig["effort"]
  readonly approvals?: SandboxConfig["approvals"]
  /** Extra config keys (see `SandboxConfig.extra`). */
  readonly config?: ReadonlyMap<string, Schema.Json>
  /** Extra environment for every CLI process. */
  readonly env?: ReadonlyMap<string, string>
  /** Have the CLI export its sessions to the e2e Phoenix project. Implies `needs: phoenix`. */
  readonly phoenix?: boolean
  /** Prerequisites; the scenario is skipped (not failed) when one is missing. */
  readonly needs?: ReadonlyArray<Need>
  /**
   * The GitHub issue this scenario specifies, for behaviour not built yet.
   * Pending scenarios are skipped unless `OI_E2E_PENDING` lists the issue
   * (`OI_E2E_PENDING=11,13`) or is `all`.
   */
  readonly pending?: number
  /** Live-model scenarios cannot be replayed (judges, sampling); skip them in replay mode. */
  readonly liveOnly?: boolean
  /** Opt in to isolated headless samples. Requires liveOnly and no Rex. */
  readonly samples?: boolean
  /**
   * Something outside the sandbox that this scenario changes or depends on
   * (`bundle`: the repo's `packages/cli/dist`). Scenarios naming the same
   * thing never overlap, in whichever files they are.
   */
  readonly exclusive?: string
  readonly timeoutMs?: number
}

/** How to start the CLI, when not the default way. */
export interface Launch {
  /** Script to run instead of `packages/cli/src/main.ts`. */
  readonly entry?: string
  readonly env?: ReadonlyMap<string, string>
}

export interface Sample {
  readonly sandbox: Sandbox
  readonly spans: Spans
  readonly run: (args: ReadonlyArray<string>, env?: ReadonlyMap<string, string>) => Promise<RunResult>
}

export interface Scenario {
  readonly sandbox: Sandbox
  readonly spans: Spans
  readonly mode: typeof MODE
  // Function-typed properties, not methods, so scenarios can destructure them.
  /** Start the interactive CLI in a Rex terminal. */
  readonly tui: (args?: ReadonlyArray<string>, launch?: Launch) => Promise<Terminal>
  /** Run the CLI without a terminal (`oi run`, `oi export`, …). */
  readonly run: (args: ReadonlyArray<string>, env?: ReadonlyMap<string, string>) => Promise<RunResult>
  /** Extra text for the failure message, and for the scenario's span in Phoenix. */
  readonly note: (text: string) => void
  /** Each attempt gets a fresh sandbox; retries only the known ChatGPT availability error. */
  readonly samples: <A, B>(
    entries: ReadonlyArray<A>,
    body: (s: Sample, entry: A, retries: number) => Promise<B>,
  ) => Promise<Array<B>>
  /** Persist JSON outside disposable sandboxes, print once, and attach to Phoenix. */
  readonly results: (rows: ReadonlyArray<Schema.Json>) => void
}

const runId = Date.now().toString(36)

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 60)

const hasKeychain = (account: string): boolean => {
  if (process.platform !== "darwin") return false

  try {
    execFileSync("security", ["find-generic-password", "-s", "oi-agent", "-a", account], { stdio: "ignore" })

    return true
  } catch {
    return false
  }
}

const providerOf = (model: string): string => model.split("/")[0] ?? ""

const hasProvider = (model: string): boolean => {
  if (MODE === "replay") return true

  const provider = providerOf(model)

  if (provider === "anthropic")
    return process.env["ANTHROPIC_API_KEY"] !== undefined || hasKeychain("anthropic")

  if (provider === "openai") return process.env["OPENAI_API_KEY"] !== undefined || hasKeychain("openai")

  if (provider === "chatgpt") return hasKeychain("chatgpt")

  return true
}

/** Why a prerequisite is missing, or `undefined` when it is met. */
const missing = async (need: Need): Promise<string | undefined> => {
  switch (need) {
    case "typesafe":
      return getSecret("typesafe") === undefined ? "no TypeSafe credentials" : undefined
    case "rex":
      return (await findRex()) === undefined ? "Rex is not installed" : undefined
    case "phoenix":
      return (await phoenixUp()) ? undefined : `Phoenix is not reachable at ${PHOENIX_ENDPOINT}`
    case "phoenix-auth":
      return (await phoenixAuthUp())
        ? undefined
        : `no Phoenix with auth to log in to at ${PHOENIX_AUTH_ENDPOINT} (see the README)`
    case "second-model":
      return hasProvider(MODELS.second) ? undefined : `no credentials for ${MODELS.second}`
  }
}

const pendingEnabled = (issue: number): boolean => {
  const list = process.env["OI_E2E_PENDING"] ?? ""

  return (
    list === "all" ||
    list
      .split(",")
      .map((entry) => entry.trim().replace(/^#/, ""))
      .includes(String(issue))
  )
}

/** Fail with the CLI's stderr unless it exited 0. Returns the result for chaining. */
export const expectOk = (result: RunResult): RunResult => {
  if (result.code !== 0)
    throw new Error(
      `oi exited ${result.code}.\nstderr:\n${result.stderr.slice(-2000)}\nstdout:\n${result.stdout.slice(-1000)}`,
    )

  return result
}

export const scenario = (
  name: string,
  options: ScenarioOptions,
  body: (s: Scenario) => Promise<void>,
): void => {
  const timeout = options.timeoutMs ?? 240_000
  const pending = options.pending !== undefined && !pendingEnabled(options.pending)

  const label =
    options.pending === undefined ? name : `${name} [#${options.pending}${pending ? ", pending" : ""}]`

  // Pending scenarios specify behaviour that is not built yet; OI_E2E_PENDING runs them.
  // The assertions are in each scenario's body, and its title is the scenario's name.
  // oxlint-disable-next-line vitest/expect-expect
  it.skipIf(pending)(
    // oxlint-disable-next-line vitest/valid-title
    label,
    async (context) => {
      const needs = new Set<Need>(options.needs ?? [])

      if (options.phoenix === true) needs.add("phoenix")

      for (const need of needs) {
        const reason = await missing(need)

        if (reason !== undefined) {
          context.skip(reason)

          return
        }
      }

      const model = options.model ?? MODELS.main

      if (!hasProvider(model)) {
        context.skip(`no credentials for ${model}`)

        return
      }

      if (options.liveOnly === true && MODE === "replay") {
        context.skip("needs live models")

        return
      }

      if (options.samples === true && (options.liveOnly !== true || needs.has("rex")))
        throw new Error("Samples require liveOnly: true and no Rex")

      const id = `${runId}-${slug(name)}`

      // Live-only scenarios are never replayed, so they have nothing to record.
      const proxy =
        MODE === "live" || options.liveOnly === true ? undefined : await ModelProxy.start(MODE, slug(name))

      const phoenix = options.phoenix === true

      const sandboxOptions: SandboxOptions = {
        fixture: options.fixture ?? "basic",
        config: {
          model: options.model ?? MODELS.main,
          effort: options.effort ?? "low",
          approvals: options.approvals ?? "ask",
          phoenixEndpoint: phoenix ? PHOENIX_ENDPOINT : "",
          phoenixProject: PHOENIX_PROJECT,
          // Scenarios say exactly which tools they expect: only those about delegation let the agent delegate.
          extra: new Map<string, Schema.Json>([
            ["delegation", "off"],
            ["web", "off"],
            ...(options.config ?? []),
          ]),
        },
        // A developer's decision key must not add auto mode to unrelated TUI tests,
        // or turn replay into real decision calls. Only the live service scenario opts in.
        env: new Map([
          ...(proxy?.env() ?? []),
          ["TYPESAFE_API_KEY", needs.has("typesafe") ? (getSecret("typesafe") ?? "") : ""],
          ...(options.env ?? []),
        ]),
        confine: process.env["OI_E2E_CONFINE"] !== "0" && canConfine(),
      }

      const sandbox = new Sandbox(slug(name), sandboxOptions)
      const spans = new Spans(sandbox.home)
      const children: Array<Sample> = []
      const results: Array<Schema.Json> = []
      const terminals: Array<RexTerminal> = []
      const notes: Array<string> = []
      const startNs = nowNs()
      let failure: string | undefined

      const s: Scenario = {
        sandbox,
        spans,
        mode: MODE,
        tui: async (args = [], launch = {}) => {
          if (options.samples === true) throw new Error("Sample scenarios cannot open Rex terminals")

          const terminal = await RexTerminal.start(
            `oi-e2e-${id}-${terminals.length + 1}`,
            sandbox.cwd,
            sandbox.oiCommand(args, launch.env, launch.entry),
          )

          terminals.push(terminal)

          return terminal
        },
        run: (args, env) => sandbox.run(args, env),
        samples: async (entries, body) => {
          if (options.samples !== true) throw new Error("Declare samples: true to run isolated samples")

          return mapSamples(entries, positiveInteger("OI_E2E_CONCURRENCY", 4), async (entry, index) => {
            for (let retries = 0; ; retries += 1) {
              const child = new Sandbox(`${slug(name)}-${index}-${retries}`, sandboxOptions)

              const sample: Sample = {
                sandbox: child,
                spans: new Spans(child.home),
                run: (args, env) => child.run(args, env),
              }

              children.push(sample)

              try {
                return await body(sample, entry, retries)
              } catch (error) {
                if (
                  retries !== 0 ||
                  !(error instanceof Error) ||
                  !error.message.includes("The ChatGPT user is temporarily unavailable")
                )
                  throw error

                notes.push(`sample ${index}: ChatGPT unavailable; retrying once in a fresh sandbox`)
              }
            }
          })
        },
        results: (rows) => {
          results.push(...rows)
        },
        note: (text) => {
          notes.push(text)
        },
      }

      try {
        await (options.exclusive === undefined ? body(s) : withLock(options.exclusive, () => body(s)))

        const misses = proxy?.misses.filter((miss) => !miss.startsWith("GET")) ?? []

        if (misses.length > 0)
          throw new Error(
            `Replay had no recorded reply for:\n  ${misses.join("\n  ")}\nRe-record with OI_E2E_MODELS=record.`,
          )
      } catch (error) {
        const sections = [error instanceof Error ? error.message : String(error)]

        sections.push(
          `--- sessions (${path.relative(process.cwd(), sandbox.home) || sandbox.home}) ---`,
          spans.summary(),
        )

        for (const child of children)
          sections.push(`--- sample ${child.sandbox.root} ---`, child.spans.summary())

        for (const [index, terminal] of terminals.entries())
          sections.push(
            `--- terminal ${index + 1} ---`,
            tail(await terminal.screen().catch(() => "(gone)"), 40),
          )

        if (notes.length > 0) sections.push("--- notes ---", ...notes)

        if (process.env["OI_E2E_KEEP"] === "1") sections.push(`--- sandbox kept at ${sandbox.root} ---`)

        failure = sections.join("\n")

        throw new Error(failure, { cause: error })
      } finally {
        await Promise.all(terminals.map((terminal) => terminal.close()))

        const sessionIds = [...spans.sessions(), ...children.flatMap((child) => child.spans.sessions())]

        for (const child of children) child.spans.close()

        if (results.length > 0) {
          const directory = process.env["OI_E2E_RESULTS_DIR"] ?? path.join(os.tmpdir(), "oi-e2e-results")

          fs.mkdirSync(directory, { recursive: true })

          const file = path.join(directory, `${id}.json`)

          fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`)
          process.stdout.write(`${label}: results ${file}\n`)
          console.table(results, ["case", "sample", "learned", "producers", "retries", "durationMs"])
        }

        spans.close()
        await proxy?.stop(failure === undefined)
        await reportScenario({
          name: label,
          file: id,
          mode: MODE,
          startNs,
          sessionIds,
          error: failure,
          notes,
          results,
          sandbox: sandbox.root,
        })

        // Scores and other notes are worth seeing when a scenario passes too.
        if (failure === undefined && notes.length > 0)
          process.stdout.write(`${label}:\n${notes.map((line) => `  ${line}`).join("\n")}\n`)

        for (const child of children)
          child.sandbox.dispose(failure !== undefined && process.env["OI_E2E_KEEP"] === "1")

        sandbox.dispose(failure !== undefined && process.env["OI_E2E_KEEP"] === "1")
      }
    },
    timeout,
  )
}

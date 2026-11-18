/**
 * Choosing a Phoenix server and how to authenticate to it: one conversation,
 * held by `oi setup` in plain prompts and by `/phoenix` inside a running
 * session. Each answer is checked against the server before the next
 * question, so what is saved at the end is known to work.
 *
 * The key never passes through here in the open: it is typed hidden or made
 * by a browser login, checked, and stored in the keychain.
 */
import { hostname } from "node:os"
import {
  checkPhoenixKey,
  type Config,
  deleteSecret,
  discoverPhoenixLogin,
  getSecret,
  type PhoenixLogin,
  PhoenixLoginError,
  type PhoenixProbe,
  probePhoenix,
  setSecret,
  startPhoenixLogin,
} from "@oi-agent/engine"

export const LOCAL_PHOENIX = "http://localhost:6006"

export interface Option {
  readonly value: string
  readonly label: string
  readonly hint?: string
}

/**
 * How the conversation is held. Every question resolves to `undefined` when
 * the person backs out, and the whole setup then ends having changed nothing.
 */
export interface Dialog {
  /** A line of text; an empty answer is `fallback`. */
  readonly ask: (label: string, fallback: string) => Promise<string | undefined>
  /** A line typed hidden. */
  readonly secret: (label: string) => Promise<string | undefined>
  readonly choose: (
    title: string,
    options: ReadonlyArray<Option>,
    fallback: string,
  ) => Promise<string | undefined>
  readonly ok: (text: string) => void
  readonly warn: (text: string) => void
  readonly note: (text: string) => void
  /** Open a page in the person's browser, and show its address in case that did nothing. */
  readonly open: (url: string) => void
  /**
   * Ask for a line while something else is awaited: resolves with what was
   * typed, or `undefined` when the person backed out or `until` settled first.
   */
  readonly paste: (label: string, until: Promise<unknown>) => Promise<string | undefined>
}

/** A URL as typed by a person: without a scheme, a local address is http and anything else https. */
export const normalizeEndpoint = (typed: string): string => {
  const text = typed.trim().replace(/\/+$/, "")

  if (/^https?:\/\//i.test(text)) return text

  return /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(text) ? `http://${text}` : `https://${text}`
}

const describe = (endpoint: string, probe: PhoenixProbe): string => {
  const what = probe.version === undefined ? "Phoenix" : `Phoenix ${probe.version}`

  return probe.auth === "required"
    ? `Connected to ${what} at ${endpoint}. It asks for a login.`
    : `Connected to ${what} at ${endpoint}.`
}

/** Which server, checked: its address and what it said about itself, or `none`, or backed out. */
const chooseServer = async (
  dialog: Dialog,
  current: Config["phoenix"],
): Promise<{ readonly endpoint: string; readonly probe: PhoenixProbe } | "none" | undefined> => {
  const detected = current.endpoint === "" ? (await probePhoenix(LOCAL_PHOENIX)).version : undefined

  if (detected !== undefined) dialog.ok(`Found Phoenix ${detected} at ${LOCAL_PHOENIX}.`)

  let suggestion = current.endpoint === "" && detected !== undefined ? LOCAL_PHOENIX : current.endpoint

  for (;;) {
    const answer = await dialog.ask(
      "Phoenix URL (type `none` to turn export off)",
      suggestion === "" ? "none" : suggestion,
    )

    if (answer === undefined) return undefined

    if (answer === "none") return "none"

    const endpoint = normalizeEndpoint(answer)
    const probe = await probePhoenix(endpoint)

    if (probe.auth !== "unknown") {
      dialog.ok(describe(endpoint, probe))

      return { endpoint, probe }
    }

    dialog.warn(`${endpoint} did not answer as Phoenix: ${probe.detail ?? "no answer"}.`)

    const next = await dialog.choose(
      "What now?",
      [
        { value: "retry", label: "Enter a different URL" },
        { value: "keep", label: "Use it anyway", hint: "export keeps trying; nothing is lost meanwhile" },
      ],
      "retry",
    )

    if (next === undefined) return undefined

    if (next === "keep") return { endpoint, probe }

    suggestion = endpoint
  }
}

type LoginOutcome =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "error"; readonly error: PhoenixLoginError }

/** Wait for the browser, taking a pasted address if the browser cannot come back by itself. */
const viaBrowser = async (dialog: Dialog, login: PhoenixLogin): Promise<string | undefined> => {
  let settled = false

  const outcome: Promise<LoginOutcome> = login.key
    .then(
      (key): LoginOutcome => ({ kind: "key", key }),
      (error): LoginOutcome => ({
        kind: "error",
        error:
          error instanceof PhoenixLoginError ? error : new PhoenixLoginError("failed", "The login failed."),
      }),
    )
    .finally(() => {
      settled = true
    })

  dialog.open(login.url)

  while (!settled) {
    const typed = await dialog.paste(
      "Waiting for the browser · if it cannot reach this machine, paste the address it ended on · esc cancels",
      outcome,
    )

    if (settled) break

    if (typed === undefined) login.cancel()
    else if (typed !== "") {
      const problem = login.paste(typed)

      if (problem !== undefined) dialog.warn(problem)
    }

    // Let a cancel or an accepted paste settle before asking again.
    await Promise.race([outcome, new Promise((resolve) => setTimeout(resolve, 50))])
  }

  const result = await outcome

  if (result.kind === "key") return result.key

  if (result.error.reason !== "cancelled") dialog.warn(result.error.message)

  return undefined
}

/** What to do with the keychain once everything else is settled. */
type KeyChange =
  | { readonly kind: "none" }
  | { readonly kind: "store"; readonly key: string }
  | { readonly kind: "remove" }

/** How to authenticate to a server that asks for it. Resolves to the change to make, or `undefined` when backed out. */
const chooseCredentials = async (
  dialog: Dialog,
  endpoint: string,
  project: string,
  probe: PhoenixProbe,
  env: NodeJS.ProcessEnv,
): Promise<KeyChange | undefined> => {
  const fromEnv = env["PHOENIX_API_KEY"] !== undefined && env["PHOENIX_API_KEY"] !== ""
  const stored = getSecret("phoenix")

  if (fromEnv)
    dialog.warn("PHOENIX_API_KEY is set in your environment, and is used instead of a key stored here.")

  const support =
    probe.auth === "required"
      ? await discoverPhoenixLogin(endpoint)
      : ({ status: "unsupported", why: "" } as const)

  if (support.status === "unsupported" && support.why !== "")
    dialog.note(`${support.why} Paste an API key instead: create one in Phoenix under Settings.`)

  if (support.status === "unreachable")
    dialog.warn(`Could not ask Phoenix whether it supports browser login: ${support.detail}.`)

  const options: Array<Option> = []

  if (support.status === "supported")
    options.push({
      value: "login",
      label: "Log in with your browser",
      hint: "Phoenix makes an API key for oi, kept in your keychain",
    })

  options.push({ value: "paste", label: "Paste an API key", hint: "hidden as you type" })

  if (stored !== undefined) options.push({ value: "keep", label: "Keep the current key" })

  if (stored !== undefined && !fromEnv) options.push({ value: "remove", label: "Remove the stored key" })

  if (probe.auth !== "required") options.push({ value: "skip", label: "No key" })

  for (;;) {
    const choice = await dialog.choose(
      "How should oi authenticate to Phoenix?",
      options,
      stored !== undefined ? "keep" : (options[0]?.value ?? "paste"),
    )

    if (choice === undefined) return undefined

    if (choice === "skip") return { kind: "none" }

    if (choice === "remove") return { kind: "remove" }

    let key = choice === "keep" ? stored : undefined

    if (choice === "paste") key = await dialog.secret("Phoenix API key (hidden as you type)")

    if (choice === "login") {
      const login = await startPhoenixLogin({
        endpoint,
        keyName: `oi-agent ${hostname()}`,
        keyDescription: `Created by oi for project ${project}.`,
        env,
      }).catch((error: Error) => {
        dialog.warn(error.message)

        return undefined
      })

      key = login === undefined ? undefined : await viaBrowser(dialog, login)
    }

    // Backed out of this way of authenticating, not of the setup: offer the ways again.
    if (key === undefined || key === "") continue

    const verdict = await checkPhoenixKey(endpoint, key)

    if (verdict === "rejected") {
      dialog.warn("Phoenix did not accept that key.")
      continue
    }

    if (verdict === "accepted") dialog.ok("Phoenix accepted the key.")
    else dialog.warn("Could not reach Phoenix to check the key. It is kept, and export will keep trying.")

    return choice === "keep" ? { kind: "none" } : { kind: "store", key }
  }
}

/**
 * Hold the conversation. Resolves to where Phoenix is from now on (an empty
 * endpoint turns export off), with the keychain already changed to match, or
 * to `undefined` when the person backed out, with nothing changed at all.
 * Saving the result to the config file is the caller's.
 */
export const setupPhoenix = async (
  dialog: Dialog,
  current: Config["phoenix"],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config["phoenix"] | undefined> => {
  const server = await chooseServer(dialog, current)

  if (server === undefined) return undefined

  if (server === "none") return { endpoint: "", project: current.project }

  const project = await dialog.ask("Phoenix project", current.project)

  if (project === undefined) return undefined

  const change: KeyChange | undefined =
    server.probe.auth === "none"
      ? { kind: "none" }
      : await chooseCredentials(dialog, server.endpoint, project, server.probe, env)

  if (change === undefined) return undefined

  if (change.kind === "store") {
    if (setSecret("phoenix", change.key)) dialog.ok("Saved the key to the keychain.")
    else dialog.warn("Could not save the key to the keychain. Set PHOENIX_API_KEY instead.")
  }

  if (change.kind === "remove" && deleteSecret("phoenix")) dialog.ok("Removed the stored key.")

  // What the environment sets wins over the file at the next start: say so, or the change looks lost.
  for (const [name, value] of [
    ["PHOENIX_COLLECTOR_ENDPOINT", server.endpoint],
    ["PHOENIX_PROJECT_NAME", project],
  ] as const) {
    if (env[name] !== undefined && env[name] !== value)
      dialog.warn(`${name} is set in your environment and wins over this choice the next time oi starts.`)
  }

  return { endpoint: server.endpoint, project }
}

/**
 * User configuration: `~/.config/oi-agent/config.json`, overridable by
 * environment. Holds no secrets; see `secrets.ts`.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Option, Schema } from "effect"
import { ProviderConfig, splitModel } from "./providers.ts"

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])

export type Effort = typeof Effort.Type

/** Effort levels from least to most. */
export const EFFORTS: ReadonlyArray<Effort> = Effort.literals

export const Approvals = Schema.Literals(["ask", "allow"])

export type Approvals = typeof Approvals.Type

export const Config = Schema.Struct({
  /** The provider serving `model`: a built-in (`anthropic`, `openai`, `chatgpt`) or one in `providers`. */
  provider: Schema.String,
  /** Model id at that provider, for example `claude-opus-5-5`. */
  model: Schema.String,
  /** OpenAI-compatible servers added with `/provider add`. */
  providers: Schema.Array(ProviderConfig),
  effort: Effort,
  max_tokens: Schema.Int,
  /** Display name recorded as `user.id` on turns started from this machine. */
  user: Schema.String,
  /** Whether tools that change the machine wait for a yes. */
  approvals: Approvals,
  /** Model used by evaluators and to distill rules. */
  judge_model: Schema.String,
  /** Directory that holds sessions. */
  home: Schema.String,
  phoenix: Schema.Struct({
    /** Base URL of a Phoenix server; empty disables export. */
    endpoint: Schema.String,
    project: Schema.String,
  }),
})

export type Config = typeof Config.Type

const PartialConfig = Schema.fromJsonString(
  Schema.Struct({
    provider: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    providers: Schema.optionalKey(Schema.Array(ProviderConfig)),
    effort: Schema.optionalKey(Effort),
    max_tokens: Schema.optionalKey(Schema.Int),
    user: Schema.optionalKey(Schema.String),
    approvals: Schema.optionalKey(Approvals),
    judge_model: Schema.optionalKey(Schema.String),
    home: Schema.optionalKey(Schema.String),
    phoenix: Schema.optionalKey(
      Schema.Struct({
        endpoint: Schema.optionalKey(Schema.String),
        project: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
)

const decodePartial = Schema.decodeUnknownOption(PartialConfig)
const decodeEffort = Schema.decodeUnknownOption(Effort)
const encodeConfig = Schema.encodeSync(Config)

const readFile = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** `$OI_AGENT_CONFIG_DIR`, else `$XDG_CONFIG_HOME/oi-agent`, else `~/.config/oi-agent`. */
export const configDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env["OI_AGENT_CONFIG_DIR"] ??
  path.join(env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), "oi-agent")

export const configPath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(configDir(env), "config.json")

/**
 * Where a project's evaluators and learned rules live:
 * `<config>/projects/<name>-<hash>/`. They are kept out of the project itself
 * so the agent never needs write access to, or leaves files in, the tree it
 * is working on.
 */
export const projectDir = (cwd: string, env: NodeJS.ProcessEnv = process.env): string => {
  const resolved = path.resolve(cwd)
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 10)
  const name = path.basename(resolved).replaceAll(/[^a-zA-Z0-9._-]/g, "_") || "root"

  return path.join(configDir(env), "projects", `${name}-${hash}`)
}

/** Whether the user has been through setup on this machine. */
export const hasConfig = (env: NodeJS.ProcessEnv = process.env): boolean => fs.existsSync(configPath(env))

export const defaultHome = (): string => path.join(os.homedir(), ".oi-agent")

const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
const decodeConfigObject = Schema.decodeUnknownOption(ConfigObject)

type PartialConfig = typeof PartialConfig.Type

/** What the config file sets, and the keys it sets to values that are not valid. */
interface FileSettings {
  readonly settings: PartialConfig | undefined
  readonly invalid: ReadonlyArray<string>
}

/**
 * Read the config file one key at a time, so a single bad value (a typo, or a
 * setting from a newer version) loses only that key rather than the whole
 * file, which would quietly put every setting back to its default.
 */
const readSettings = (env: NodeJS.ProcessEnv): FileSettings => {
  const text = readFile(configPath(env))

  if (text === undefined) return { settings: undefined, invalid: [] }

  return Option.match(decodePartial(text), {
    onSome: (settings) => ({ settings, invalid: [] }),
    onNone: () =>
      Option.match(decodeConfigObject(text), {
        onNone: () => ({ settings: undefined, invalid: ["the whole file (it is not a JSON object)"] }),
        onSome: (object) => {
          const entries = Object.entries(object)

          const fits = ([key, value]: readonly [string, Schema.Json]) =>
            Option.isSome(decodePartial(JSON.stringify({ [key]: value })))

          const valid = entries.filter(fits)

          return {
            settings: Option.getOrUndefined(decodePartial(JSON.stringify(Object.fromEntries(valid)))),
            invalid: entries.filter((entry) => !fits(entry)).map(([key]) => key),
          }
        },
      }),
  })
}

/**
 * Config file keys whose values were ignored because they are not valid,
 * as warnings to show the user. Empty when the file is fine or absent.
 */
export const configProblems = (env: NodeJS.ProcessEnv = process.env): Array<string> => {
  const { invalid } = readSettings(env)

  if (invalid.length === 0) return []

  return [
    `${configPath(env)}: ignoring ${invalid.join(", ")}, which ${invalid.length === 1 ? "is" : "are"} not valid. Every other setting still applies.`,
  ]
}

/** Settings from the config file, with environment variables taking precedence. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const file = readSettings(env).settings
  const providers = file?.providers ?? []

  // `OI_AGENT_MODEL=openai/gpt-5.1` picks the provider as well as the model.
  const choice = splitModel(
    providers,
    env["OI_AGENT_MODEL"] ?? file?.model ?? "claude-opus-5-5",
    env["OI_AGENT_PROVIDER"] ?? file?.provider ?? "anthropic",
  )

  return {
    provider: choice.provider,
    model: choice.model,
    providers,
    effort: Option.getOrUndefined(decodeEffort(env["OI_AGENT_EFFORT"])) ?? file?.effort ?? "high",
    max_tokens: file?.max_tokens ?? 64_000,
    user: env["OI_AGENT_USER"] ?? file?.user ?? env["USER"] ?? "user",
    approvals: file?.approvals ?? "ask",
    judge_model: env["OI_AGENT_JUDGE_MODEL"] ?? file?.judge_model ?? "claude-haiku-5-5",
    home: env["OI_AGENT_HOME"] ?? file?.home ?? defaultHome(),
    phoenix: {
      endpoint: env["PHOENIX_COLLECTOR_ENDPOINT"] ?? file?.phoenix?.endpoint ?? "",
      project: env["PHOENIX_PROJECT_NAME"] ?? file?.phoenix?.project ?? "oi-agent",
    },
  }
}

export const saveConfig = (config: Config, env: NodeJS.ProcessEnv = process.env): string => {
  const file = configPath(env)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(encodeConfig(config), null, 2)}\n`)

  return file
}

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
const decodeObject = Schema.decodeUnknownOption(JsonObject)
const encodeProviders = Schema.encodeSync(Schema.Array(ProviderConfig))

/**
 * Replace the `providers` list in the config file, leaving every other key
 * as written. (Saving a whole loaded config would also write environment
 * overrides into the file.)
 */
export const saveProviders = (
  providers: ReadonlyArray<ProviderConfig>,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  const file = configPath(env)
  const current = Option.getOrElse(decodeObject(readFile(file)), () => ({}))

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...current, providers: encodeProviders(providers) }, null, 2)}\n`,
  )
}

/**
 * User configuration: `<home>/config.json`, overridable by environment.
 * Holds no secrets; see `secrets.ts`.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Option, Schema } from "effect"

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])

export type Effort = typeof Effort.Type

export const Config = Schema.Struct({
  /** Model id, for example `claude-opus-5-5`. */
  model: Schema.String,
  effort: Effort,
  max_tokens: Schema.Int,
  /** Display name recorded as `user.id` on turns started from this machine. */
  user: Schema.String,
  phoenix: Schema.Struct({
    /** Base URL of a Phoenix server; empty disables export. */
    endpoint: Schema.String,
    project: Schema.String,
  }),
})

export type Config = typeof Config.Type

const PartialConfig = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Effort),
    max_tokens: Schema.optionalKey(Schema.Int),
    user: Schema.optionalKey(Schema.String),
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

const readFile = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

export const configPath = (home: string): string => path.join(home, "config.json")

export const loadConfig = (home: string, env: NodeJS.ProcessEnv = process.env): Config => {
  const file = Option.getOrUndefined(decodePartial(readFile(configPath(home))))

  return {
    model: env["OI_AGENT_MODEL"] ?? file?.model ?? "claude-opus-5-5",
    effort: Option.getOrUndefined(decodeEffort(env["OI_AGENT_EFFORT"])) ?? file?.effort ?? "high",
    max_tokens: file?.max_tokens ?? 64_000,
    user: env["OI_AGENT_USER"] ?? file?.user ?? env["USER"] ?? "user",
    phoenix: {
      endpoint: env["PHOENIX_COLLECTOR_ENDPOINT"] ?? file?.phoenix?.endpoint ?? "",
      project: env["PHOENIX_PROJECT_NAME"] ?? file?.phoenix?.project ?? "oi-agent",
    },
  }
}

const encodeConfig = Schema.encodeSync(Config)

export const saveConfig = (home: string, config: Config): void => {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(configPath(home), `${JSON.stringify(encodeConfig(config), null, 2)}\n`)
}

/**
 * Secret storage. Keys live in the operating system keychain, with an
 * environment variable taking precedence. Nothing here ever writes a secret
 * inside the session tree.
 */
import { execFileSync } from "node:child_process"

const SERVICE = "oi-agent"

const ENV_NAMES = new Map([
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["phoenix", "PHOENIX_API_KEY"],
])

const run = (command: string, args: ReadonlyArray<string>, input?: string): string | undefined => {
  try {
    return execFileSync(command, [...args], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

const keychainGet = (account: string): string | undefined =>
  process.platform === "darwin"
    ? run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
    : run("secret-tool", ["lookup", "service", SERVICE, "account", account])

export const getSecret = (account: string): string | undefined => {
  const envName = ENV_NAMES.get(account)
  const fromEnv = envName === undefined ? undefined : process.env[envName]
  const value = fromEnv ?? keychainGet(account)

  return value === undefined || value === "" ? undefined : value
}

/** Store a secret in the keychain. Returns whether the keychain accepted it. */
export const setSecret = (account: string, value: string): boolean =>
  (process.platform === "darwin"
    ? run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value])
    : run(
        "secret-tool",
        ["store", "--label", `${SERVICE} ${account}`, "service", SERVICE, "account", account],
        value,
      )) !== undefined

export const deleteSecret = (account: string): boolean =>
  (process.platform === "darwin"
    ? run("security", ["delete-generic-password", "-s", SERVICE, "-a", account])
    : run("secret-tool", ["clear", "service", SERVICE, "account", account])) !== undefined

/**
 * A throwaway world for one scenario: its own config directory, session
 * home, temp directory and working copy of a fixture repo, all under one
 * root. On macOS the CLI runs under `sandbox-exec` with a profile that
 * denies writes outside that root and reads of the real oi-agent config and
 * sessions, so even `--yolo` cannot touch the developer's machine.
 */
import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { Schema } from "effect"

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url))

export const CLI_ENTRY = path.join(REPO_ROOT, "packages/cli/src/main.ts")

/** What `oi` runs: the launcher, which starts `CLI_ENTRY` (as `bin/oi` does) and restarts it on /reload. */
export const LAUNCHER = path.join(REPO_ROOT, "packages/cli/src/launcher.ts")

const FIXTURES = fileURLToPath(new URL("../fixtures/repos", import.meta.url))

/** Settings written to the sandbox's `config.json`. Unset fields keep the CLI's defaults. */
export interface SandboxConfig {
  readonly model: string
  readonly effort: "low" | "medium" | "high"
  readonly approvals: "ask" | "allow" | "auto"
  /**
   * Other top-level keys, for settings that scenarios of unbuilt features
   * need (`decision`, `steering`). The CLI ignores keys it does not know.
   */
  readonly extra: ReadonlyMap<string, Schema.Json>
  /** Phoenix base URL; empty keeps export off. */
  readonly phoenixEndpoint: string
  readonly phoenixProject: string
}

export interface SandboxOptions {
  /** A directory under `fixtures/repos` to copy in as the working directory. */
  readonly fixture: string
  readonly config: SandboxConfig
  /** Extra environment for every command run in the sandbox. */
  readonly env: ReadonlyMap<string, string>
  /** Use `sandbox-exec` (macOS only). Defaults to on where available. */
  readonly confine: boolean
}

export const canConfine = (): boolean =>
  process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")

/** Escape a path for a sandbox profile string literal. */
const sbString = (value: string): string => JSON.stringify(value)

/**
 * The sandbox profile. Everything is allowed except writing outside the
 * sandbox (plus the few system places a process must write) and reading the
 * developer's real oi-agent state and their user-level agent instructions.
 */
const profile = (root: string): string => {
  const home = os.homedir()
  const realRoot = fs.realpathSync(root)

  const writable = [
    realRoot,
    root,
    "/dev",
    // The ChatGPT sign-in refreshes its token in the login keychain.
    path.join(home, "Library/Keychains"),
  ]

  const hidden = [
    path.join(home, ".oi-agent"),
    path.join(home, ".config/oi-agent"),
    path.join(home, "Library/Preferences/oi-agent"),
    // The developer's own instructions and skills for coding agents, which oi would otherwise find.
    path.join(home, ".claude"),
    path.join(home, ".agents"),
    path.join(home, ".config/AGENTS.md"),
  ]

  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((dir) => `(subpath ${sbString(dir)})`).join(" ")})`,
    `(deny file-read* ${hidden.map((dir) => `(subpath ${sbString(dir)})`).join(" ")})`,
    "",
  ].join("\n")
}

const copyFixture = (name: string, dest: string): void => {
  const source = path.join(FIXTURES, name)

  if (!fs.existsSync(source)) throw new Error(`No fixture repo named ${name} in ${FIXTURES}`)

  fs.cpSync(source, dest, { recursive: true })

  // A real checkout, so the workspace recorded on each turn has a commit.
  const git = (...args: Array<string>) =>
    execFileSync("git", args, { cwd: dest, stdio: "ignore", env: { ...process.env, ...GIT_ENV } })

  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "fixture")
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "oi e2e",
  GIT_AUTHOR_EMAIL: "e2e@example.invalid",
  GIT_COMMITTER_NAME: "oi e2e",
  GIT_COMMITTER_EMAIL: "e2e@example.invalid",
}

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export class Sandbox {
  readonly root: string
  readonly configDir: string
  readonly home: string
  readonly cwd: string
  readonly tmp: string
  readonly confined: boolean
  private readonly profileFile: string
  private readonly baseEnv: Map<string, string>

  constructor(label: string, options: SandboxOptions) {
    // Canonical paths (/private/var, not /var), as the CLI sees its own cwd.
    this.root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `oi-e2e-${label.replaceAll(/[^a-z0-9-]/gi, "-").slice(0, 40)}-`)),
    )
    this.configDir = path.join(this.root, "config")
    this.home = path.join(this.root, "sessions")
    this.tmp = path.join(this.root, "tmp")
    this.cwd = path.join(this.root, "work", options.fixture)
    this.profileFile = path.join(this.root, "sandbox.sb")
    this.confined = options.confine && canConfine()

    for (const dir of [this.configDir, this.home, this.tmp]) fs.mkdirSync(dir, { recursive: true })

    copyFixture(options.fixture, this.cwd)
    this.writeConfig(options.config)
    fs.writeFileSync(this.profileFile, profile(this.root))

    this.baseEnv = new Map([
      ["PATH", process.env["PATH"] ?? "/usr/bin:/bin"],
      ["HOME", os.homedir()],
      ["USER", os.userInfo().username],
      ["TERM", "xterm-256color"],
      ["LANG", "en_US.UTF-8"],
      ["TMPDIR", this.tmp],
      ["OI_AGENT_CONFIG_DIR", this.configDir],
      ["OI_AGENT_HOME", this.home],
      ...Object.entries(GIT_ENV),
      ...options.env,
    ])
  }

  writeConfig(config: SandboxConfig): void {
    const file = new Map<string, Schema.Json>([
      ["model", config.model],
      ["effort", config.effort],
      ["approvals", config.approvals],
      ["user", "e2e"],
      ["home", this.home],
      ["phoenix", { endpoint: config.phoenixEndpoint, project: config.phoenixProject }],
      ...config.extra,
    ])

    fs.writeFileSync(
      path.join(this.configDir, "config.json"),
      `${JSON.stringify(Object.fromEntries(file), null, 2)}\n`,
    )
  }

  /** The environment a command in this sandbox sees, with overrides applied. */
  env(overrides: ReadonlyMap<string, string> = new Map()): Map<string, string> {
    return new Map([...this.baseEnv, ...overrides])
  }

  /**
   * The argv that runs `oi <args>` inside the sandbox with exactly the given
   * environment (`env -i`, so nothing leaks in from the caller's shell).
   */
  oiCommand(
    args: ReadonlyArray<string>,
    overrides: ReadonlyMap<string, string> = new Map(),
    entry: string = LAUNCHER,
  ): Array<string> {
    // Through the launcher, as users run oi; it runs the checkout's sources unless told otherwise.
    const launched = entry === LAUNCHER ? new Map([["OI_AGENT_ENTRY", CLI_ENTRY], ...overrides]) : overrides
    const env = [...this.env(launched)].map(([key, value]) => `${key}=${value}`)
    const inner = ["/usr/bin/env", "-i", ...env, process.execPath, entry, ...args]

    return this.confined ? ["/usr/bin/sandbox-exec", "-f", this.profileFile, ...inner] : inner
  }

  /**
   * Run `oi <args>` to completion without a terminal, as `oi run` and
   * `oi export` are used from scripts. Asynchronous on purpose: the model
   * proxy runs in this process and must keep serving while the CLI waits.
   */
  run(
    args: ReadonlyArray<string>,
    overrides: ReadonlyMap<string, string> = new Map(),
    timeoutMs = 180_000,
  ): Promise<RunResult> {
    const [command = "", ...rest] = this.oiCommand(args, overrides)

    return new Promise((resolve) => {
      const child = spawn(command, rest, { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"] })
      const stdout: Array<Buffer> = []
      const stderr: Array<Buffer> = []
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        })
      })
    })
  }

  /** A file in the working copy. */
  file(rel: string): string {
    return path.join(this.cwd, rel)
  }

  /** Remove everything, unless the scenario failed and `OI_E2E_KEEP` asks to keep it. */
  dispose(keep: boolean): void {
    if (!keep) fs.rmSync(this.root, { recursive: true, force: true })
  }
}

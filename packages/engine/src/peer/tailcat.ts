/**
 * tailcat as a sidecar: a WireGuard tunnel between two machines with no
 * account and no port forwarding. The host runs `tailcat serve <port>` and
 * hands out the printed address; a peer runs `tailcat forward` to get a local
 * port that reaches the host's peer server.
 */
import { type ChildProcess, spawn } from "node:child_process"

export interface Tunnel {
  readonly value: string
  readonly stop: () => void
}

const START_TIMEOUT_MS = 30_000

const waitFor = (child: ChildProcess, pattern: RegExp, what: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = ""

    const timer = setTimeout(
      () => reject(new Error(`tailcat did not report ${what} in time.`)),
      START_TIMEOUT_MS,
    )

    const onData = (data: Buffer): void => {
      output += data.toString("utf8")

      const match = pattern.exec(output)

      if (match?.[1] === undefined) return

      clearTimeout(timer)
      resolve(match[1])
    }

    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.on("error", () => {
      clearTimeout(timer)
      reject(new Error("tailcat is not installed. Install it with `brew install tailcat`."))
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`tailcat exited with code ${code ?? "unknown"}: ${output.trim().slice(-300)}`))
    })
  })

const start = async (args: ReadonlyArray<string>, pattern: RegExp, what: string): Promise<Tunnel> => {
  const child = spawn("tailcat", [...args], { stdio: ["ignore", "pipe", "pipe"] })

  const stop = (): void => {
    child.kill("SIGTERM")
  }

  try {
    return { value: await waitFor(child, pattern, what), stop }
  } catch (error) {
    stop()
    throw error
  }
}

/** Expose a loopback port. Resolves to the tailcat address peers connect to. */
export const tailcatServe = (port: number): Promise<Tunnel> =>
  start(["serve", String(port)], /new address: (tc[\w-]+)/, "an address")

/** Reach a served port. Resolves to the local `host:port` that forwards to it. */
export const tailcatForward = (address: string, port: number): Promise<Tunnel> =>
  start(["forward", address, `0:${port}`], /forwarding (127\.0\.0\.1:\d+)/, "a local port")

// --- share links -----------------------------------------------------------

export interface ShareLink {
  /** A tailcat address, or an `http://` base URL for a direct connection. */
  readonly address: string
  readonly port: number
  readonly token: string
}

/** `oi-share:<address>:<port>:<token>` */
export const formatShareLink = (link: ShareLink): string =>
  `oi-share:${link.address}:${link.port}:${link.token}`

export const parseShareLink = (text: string): ShareLink | undefined => {
  const match = /^oi-share:(.+):(\d+):([\w-]+)$/.exec(text.trim())

  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined

  return { address: match[1], port: Number(match[2]), token: match[3] }
}

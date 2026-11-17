import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as path from "node:path"
import { formatShareLink, parseShareLink } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { scenario } from "../src/scenario.ts"

for (const command of ["/quit", "/unshare"]) {
  scenario(
    `joined drivers and viewers exit when the host runs ${command}`,
    { needs: ["rex"], config: new Map([["steering", "off"]]) },
    async (s) => {
      const host = await s.tui()

      await host.waitFor(/enter starts a new turn/)
      await host.line("/share local")
      const screen = await host.waitFor(/View \(read-only\)/)
      const links = [...screen.matchAll(/oi join (oi-share:\S+)/g)].map((match) => match[1]!)
      const peers = []

      for (const [index, link] of links.entries()) {
        const peer = await s.tui(["join", link], {
          env: new Map([["OI_AGENT_HOME", path.join(s.sandbox.root, `peer-${index}`)]]),
        })

        await peer.waitFor(/joined .*session as/)
        peers.push(peer)
      }

      expect(peers).toHaveLength(2)
      await host.line(command)

      for (const peer of peers) {
        expect(await peer.exited(10_000)).toBe(0)
        expect(await peer.screen()).toMatch(/Host disconnected.*joined chat/i)
      }

      if (command === "/quit") expect(await host.exited(10_000)).toBe(0)
      else await host.waitFor(/Sharing stopped/)
    },
  )
}

scenario(
  "joined chat exits when a forwarding transport silently stops delivering events",
  { needs: ["rex"], config: new Map([["steering", "off"]]) },
  async (s) => {
    const host = await s.tui()

    await host.waitFor(/enter starts a new turn/)
    await host.line("/share local")
    const screen = await host.waitFor(/View \(read-only\)/)
    const link = parseShareLink(/oi join (oi-share:\S+)/.exec(screen)![1]!)!

    const proxy = http.createServer((request, response) => {
      if (request.url === "/v1/events") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(": connected\n\n")

        return
      }

      void fetch(`${link.address}:${link.port}${request.url}`, {
        headers: { authorization: `Bearer ${link.token}` },
      }).then(async (upstream) => {
        response.writeHead(upstream.status, { "content-type": "application/json" })
        response.end(Buffer.from(await upstream.arrayBuffer()))
      })
    })

    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    // SAFETY: the server is listening on a TCP port, not a pipe.
    const address = proxy.address() as AddressInfo

    try {
      const peer = await s.tui(["join", formatShareLink({ ...link, port: address.port })], {
        env: new Map([["OI_AGENT_HOME", path.join(s.sandbox.root, "peer")]]),
      })

      await peer.waitFor(/joined .*session as/)
      expect(await peer.exited(15_000)).toBe(0)
      expect(await peer.screen()).toMatch(/Host disconnected.*joined chat/i)
    } finally {
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  },
)

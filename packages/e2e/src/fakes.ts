/**
 * Local stand-ins for outside services, so scenarios control exactly what
 * the agent sees and can check exactly what it sent.
 */
import * as fs from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Option, Schema } from "effect"

const WEB_ROOT = fileURLToPath(new URL("../fixtures/web", import.meta.url))

/**
 * A secret-shaped value the redactor's patterns match. It is built at run
 * time so the repository never contains anything a secret scanner flags.
 */
export const FAKE_SECRET = ["sk", "ant", "e2e", "x".repeat(28)].join("-")

/** One request a fake server received. */
export interface Received {
  readonly method: string
  readonly url: string
  readonly headers: IncomingMessage["headers"]
  readonly body: string
}

export interface FakeServer {
  readonly url: string
  readonly requests: ReadonlyArray<Received>
  close(): Promise<void>
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = []

  for await (const chunk of request) chunks.push(Buffer.from(chunk))

  return Buffer.concat(chunks).toString("utf8")
}

const listen = async (
  handle: (request: Received) => { status: number; type: string; body: string },
): Promise<FakeServer> => {
  const requests: Array<Received> = []

  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const received = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
      }

      requests.push(received)

      const reply = handle(received)

      response.writeHead(reply.status, { "content-type": reply.type })
      response.end(reply.body)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
])

/**
 * The fixture website. `/docs/page` serves HTML, `/docs/page.md` the same
 * page as markdown, `/llms.txt` an index; `{{TOKEN}}` in a page becomes
 * `FAKE_SECRET`. `/secret` is HTML with no markdown variant.
 */
export const serveWeb = (): Promise<FakeServer> =>
  listen((request) => {
    const pathname = new URL(request.url, "http://web").pathname
    const wantsMarkdown = String(request.headers["accept"] ?? "").includes("text/markdown")
    const base = pathname === "/" ? "/index" : pathname

    const candidates =
      path.extname(base) === "" ? [`${base}${wantsMarkdown ? ".md" : ".html"}`, `${base}.html`] : [base]

    const file = candidates
      .map((rel) => path.join(WEB_ROOT, rel))
      .find((candidate) => fs.existsSync(candidate))

    if (pathname === "/secret")
      return {
        status: 200,
        type: "text/html; charset=utf-8",
        body: `<html><body><p>The deploy key is ${FAKE_SECRET}.</p></body></html>`,
      }

    if (file === undefined || !file.startsWith(WEB_ROOT))
      return { status: 404, type: "text/plain", body: "not found" }

    return {
      status: 200,
      type: TYPES.get(path.extname(file)) ?? "application/octet-stream",
      body: fs.readFileSync(file, "utf8").replaceAll("{{TOKEN}}", FAKE_SECRET),
    }
  })

const SystemOneRequest = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    state: Schema.Json,
    questions: Schema.Record(Schema.String, Schema.Struct({ type: Schema.String })),
  }),
)

const decodeSystemOne = Schema.decodeUnknownOption(SystemOneRequest)

/** How the fake decides: the noul (probability of true) for a question, given the state as text. */
export type Decide = (question: string, state: string) => number

/**
 * A System One-compatible server (`POST /v1/systemone`, issue #12). Every
 * question is answered as a noul from `decide`; choices get their first
 * option. Responses report model `jev-fake` and fixed usage.
 */
export const fakeSystemOne = (decide: Decide): Promise<FakeServer> =>
  listen((request) => {
    if (request.method !== "POST" || !request.url.startsWith("/v1/systemone"))
      return { status: 404, type: "application/json", body: '{"error":"not found"}' }

    return Option.match(decodeSystemOne(request.body), {
      onNone: () => ({ status: 400, type: "application/json", body: '{"error":"bad request"}' }),
      onSome: (parsed) => {
        const state = JSON.stringify(parsed.state)

        const answers = Object.fromEntries(
          Object.entries(parsed.questions).map(([name, question]) => [
            name,
            question.type === "noul" ? { type: "noul", noul: decide(name, state) } : { type: question.type },
          ]),
        )

        return {
          status: 200,
          type: "application/json",
          body: JSON.stringify({
            model: "jev-fake",
            answers,
            usage: { input_tokens: 120, output_tokens: 8 },
          }),
        }
      },
    })
  })

/**
 * Finding out what a Phoenix server wants before talking to it, and logging
 * in to one that wants a login.
 *
 * Phoenix is an OAuth 2.1 authorization server for public clients
 * (authorization code with PKCE, no client secret). oi uses it once, to
 * create a personal API key for the person who approved the login, and then
 * revokes the OAuth grant. The key is what the exporter and the client send
 * from then on: it does not expire under them, needs no refresh that several
 * oi processes would have to coordinate, and can be revoked in Phoenix's UI.
 *
 * Every request goes to a path under the endpoint the person typed. The
 * discovery document is read only to learn whether the server can do this,
 * never for where to send a token.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Option, Schema } from "effect"
import { configDir } from "../config.ts"
import { listenForCallback, pkceChallenge, randomToken } from "../oauth.ts"

const DISCOVERY_TIMEOUT_MS = 5_000

/** Generous: the code is single-use, so giving up on a slow exchange costs the person their consent. */
const TOKEN_TIMEOUT_MS = 30_000
const REVOKE_TIMEOUT_MS = 10_000
const LOGIN_TIMEOUT_MS = 10 * 60_000
const CALLBACK_PATH = "/callback"

/** Registered without a port: Phoenix matches a loopback redirect on host and path, so any free port works. */
const REGISTERED_REDIRECT = `http://127.0.0.1${CALLBACK_PATH}`

const base = (endpoint: string): string => endpoint.replace(/\/+$/, "")

const request = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response | string> => {
  try {
    // Anything that carries a credential refuses to be redirected; a plain GET may follow one (http to https).
    return await fetch(url, { redirect: "error", ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      return `the server did not respond within ${timeoutMs / 1000}s`

    return error instanceof Error
      ? error.cause instanceof Error
        ? error.cause.message
        : error.message
      : String(error)
  }
}

const unreachable = Schema.is(Schema.String)

// --- what the server is ------------------------------------------------------

export interface PhoenixProbe {
  /** The server's version, when it is Phoenix and answered. */
  readonly version: string | undefined
  /**
   * Whether the REST API wants credentials: `none` (it answered without
   * any), `required` (401 or 403), or `unknown` (it did not answer like
   * Phoenix at all).
   */
  readonly auth: "none" | "required" | "unknown"
  /** Why nothing is known, for a person: the network error or the status. */
  readonly detail?: string
}

/** A Phoenix version is a version number; an SPA's index.html answering the same path is not. */
const VERSION = /^\d+\.\d+\.\d+\S*$/

/** Ask a server whether it is Phoenix, and whether it wants credentials. Nothing is sent but two GETs. */
export const probePhoenix = async (endpoint: string): Promise<PhoenixProbe> => {
  const [versioned, projects] = await Promise.all([
    request(`${base(endpoint)}/arize_phoenix_version`, { redirect: "follow" }, DISCOVERY_TIMEOUT_MS),
    request(`${base(endpoint)}/v1/projects?limit=1`, { redirect: "follow" }, DISCOVERY_TIMEOUT_MS),
  ])

  if (unreachable(projects)) return { version: undefined, auth: "unknown", detail: projects }

  const text = unreachable(versioned) || !versioned.ok ? "" : (await versioned.text()).trim()
  const version = VERSION.test(text) ? text : undefined

  if (projects.status === 401 || projects.status === 403) return { version, auth: "required" }

  // A 200 that is not Phoenix's JSON is some other web server.
  const listed = projects.ok && (projects.headers.get("content-type") ?? "").includes("json")

  return listed
    ? { version, auth: "none" }
    : { version, auth: "unknown", detail: `it answered HTTP ${projects.status}, not as Phoenix does` }
}

/** Whether a key is accepted: the same request the probe makes, with the key. */
export const checkPhoenixKey = async (
  endpoint: string,
  apiKey: string | undefined,
): Promise<"accepted" | "rejected" | "unreachable"> => {
  const headers = new Headers()

  if (apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`)

  const response = await request(`${base(endpoint)}/v1/projects?limit=1`, { headers }, DISCOVERY_TIMEOUT_MS)

  if (unreachable(response) || response.status >= 500) return "unreachable"

  return response.ok ? "accepted" : "rejected"
}

// --- whether it can log a browser in ---------------------------------------------

const Metadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
})

const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(Metadata))

export type PhoenixLoginSupport =
  /** The server runs an authorization server, and lets a new client register. */
  | { readonly status: "supported" }
  /** It answered, but not with authorization server metadata, or it takes no new clients. */
  | { readonly status: "unsupported"; readonly why: string }
  /** It did not answer, or is unwell: says nothing about what it supports. */
  | { readonly status: "unreachable"; readonly detail: string }

/**
 * Whether a Phoenix can log a browser in. Only metadata that parses proves
 * it: a Phoenix from before its authorization server answers every unknown
 * path with its web app's index.html and a 200.
 */
export const discoverPhoenixLogin = async (endpoint: string): Promise<PhoenixLoginSupport> => {
  const response = await request(
    `${base(endpoint)}/.well-known/oauth-authorization-server`,
    { redirect: "follow" },
    DISCOVERY_TIMEOUT_MS,
  )

  if (unreachable(response)) return { status: "unreachable", detail: response }

  if (response.status >= 500)
    return { status: "unreachable", detail: `the server answered HTTP ${response.status}` }

  const metadata = response.ok ? Option.getOrUndefined(decodeMetadata(await response.text())) : undefined

  if (metadata === undefined)
    return { status: "unsupported", why: "This Phoenix does not support browser login." }

  return metadata.registration_endpoint === undefined
    ? { status: "unsupported", why: "This Phoenix does not let new apps register for browser login." }
    : { status: "supported" }
}

// --- the client id -------------------------------------------------------------------

const Clients = Schema.Record(Schema.String, Schema.String)
const decodeClients = Schema.decodeUnknownOption(Schema.fromJsonString(Clients))

/**
 * The client id each Phoenix gave oi when it registered: not a secret, and
 * not session state, so it is a file of its own beside the config.
 */
const clientsFile = (env: NodeJS.ProcessEnv): string => path.join(configDir(env), "phoenix-clients.json")

const readClients = (env: NodeJS.ProcessEnv): Map<string, string> => {
  try {
    return new Map(
      Object.entries(Option.getOrUndefined(decodeClients(fs.readFileSync(clientsFile(env), "utf8"))) ?? {}),
    )
  } catch {
    return new Map()
  }
}

const writeClients = (clients: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv): void => {
  fs.mkdirSync(configDir(env), { recursive: true })
  fs.writeFileSync(clientsFile(env), `${JSON.stringify(Object.fromEntries(clients), null, 2)}\n`)
}

const rememberClient = (endpoint: string, clientId: string | undefined, env: NodeJS.ProcessEnv): void => {
  const clients = readClients(env)

  if (clientId === undefined) clients.delete(base(endpoint))
  else clients.set(base(endpoint), clientId)

  writeClients(clients, env)
}

export class PhoenixLoginError extends Error {
  /** `cancelled` and `denied` are the person's own choice, and need no explaining to them. */
  readonly reason: "cancelled" | "denied" | "unsupported" | "failed"

  constructor(reason: PhoenixLoginError["reason"], message: string) {
    super(message)
    this.reason = reason
  }
}

const Registered = Schema.Struct({ client_id: Schema.String })
const decodeRegistered = Schema.decodeUnknownOption(Schema.fromJsonString(Registered))

/** Register oi as a client of this Phoenix, once; later logins reuse the id it was given. */
const clientFor = async (endpoint: string, env: NodeJS.ProcessEnv): Promise<string> => {
  const known = readClients(env).get(base(endpoint))

  if (known !== undefined) return known

  const response = await request(
    `${base(endpoint)}/oauth2/register`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "oi-agent",
        redirect_uris: [REGISTERED_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
      }),
    },
    TOKEN_TIMEOUT_MS,
  )

  if (unreachable(response)) throw new PhoenixLoginError("failed", `Could not reach Phoenix: ${response}.`)

  if (response.status === 403)
    throw new PhoenixLoginError(
      "unsupported",
      "This Phoenix does not let new apps register for browser login.",
    )

  if (response.status === 429)
    throw new PhoenixLoginError(
      "failed",
      "Phoenix is limiting how often apps may register. Try again later, or paste an API key.",
    )

  const registered = response.ok ? Option.getOrUndefined(decodeRegistered(await response.text())) : undefined

  if (registered === undefined)
    throw new PhoenixLoginError("failed", `Phoenix refused to register oi (HTTP ${response.status}).`)

  rememberClient(endpoint, registered.client_id, env)

  return registered.client_id
}

// --- the login -------------------------------------------------------------------------

const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
})

const decodeTokens = Schema.decodeUnknownOption(Schema.fromJsonString(Tokens))
const CreatedKey = Schema.Struct({ data: Schema.Struct({ key: Schema.String }) })
const decodeCreatedKey = Schema.decodeUnknownOption(Schema.fromJsonString(CreatedKey))

/** What the browser came back with, checked against the `state` this login sent out. */
type Returned =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "denied" }
  | { readonly kind: "invalid"; readonly why: string }

const returnedWith = (params: URLSearchParams, state: string): Returned => {
  // Checked first: without the right state, nothing else in the request is this login's.
  if (params.get("state") !== state) return { kind: "invalid", why: "It does not belong to this login." }

  const error = params.get("error")

  if (error === "access_denied") return { kind: "denied" }

  if (error !== null) return { kind: "invalid", why: `Phoenix reported: ${error}.` }

  const code = params.get("code")

  return code === null
    ? { kind: "invalid", why: "It carries no authorization code." }
    : { kind: "code", code }
}

export interface PhoenixLoginOptions {
  readonly endpoint: string
  /** The API key's name in Phoenix, for the person who later finds it in the list. */
  readonly keyName: string
  readonly keyDescription: string
  readonly env?: NodeJS.ProcessEnv
  /** How long to wait for the browser. */
  readonly timeoutMs?: number
}

export interface PhoenixLogin {
  /** The page to open: Phoenix asks the person to log in, then to approve oi. */
  readonly url: string
  /**
   * For a browser that cannot reach this machine (over SSH, in a container):
   * give the address it ended on, copied from its address bar. Returns why
   * that address is no use, or undefined when it was taken.
   */
  readonly paste: (redirectUrl: string) => string | undefined
  /** The new API key, once the person approved. Rejects with a `PhoenixLoginError`. */
  readonly key: Promise<string>
  readonly cancel: () => void
}

/**
 * Start a browser login. Resolves once the page to open is known; `key`
 * settles when the person approves, refuses, cancels, or ten minutes pass.
 */
export const startPhoenixLogin = async (options: PhoenixLoginOptions): Promise<PhoenixLogin> => {
  const env = options.env ?? process.env
  const endpoint = base(options.endpoint)
  const clientId = await clientFor(endpoint, env)
  const state = randomToken()
  const verifier = randomToken(64)

  let settle: (returned: Returned | PhoenixLoginError) => void = () => undefined
  const returned = new Promise<Returned | PhoenixLoginError>((resolve) => (settle = resolve))

  const server = await listenForCallback({
    path: CALLBACK_PATH,
    onCallback: (params) => {
      const result = returnedWith(params, state)

      // A request that is not this login's (another tab, a scan of local ports) does not end it.
      if (result.kind === "invalid") return { ok: false, title: "This is not the login oi is waiting for" }

      settle(result)

      return result.kind === "code"
        ? { ok: true, title: "Logged in to Phoenix" }
        : { ok: true, title: "Login was not approved" }
    },
  })

  const timer = setTimeout(
    () => settle(new PhoenixLoginError("failed", "The Phoenix login timed out.")),
    options.timeoutMs ?? LOGIN_TIMEOUT_MS,
  )

  const authorize = new URL(`${endpoint}/oauth2/authorize`)

  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: server.redirectUri,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString()

  const form = (fields: ReadonlyArray<[string, string]>): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams([...fields]),
  })

  const finish = async (): Promise<string> => {
    const outcome = await returned.finally(() => {
      clearTimeout(timer)
      server.close()
    })

    if (outcome instanceof PhoenixLoginError) {
      // Whatever went wrong may have been the client id (Phoenix forgets ones never used): register afresh next time.
      if (outcome.reason === "failed") rememberClient(endpoint, undefined, env)

      throw outcome
    }

    if (outcome.kind === "denied") throw new PhoenixLoginError("denied", "The login was not approved.")

    if (outcome.kind === "invalid") throw new PhoenixLoginError("failed", outcome.why)

    const exchanged = await request(
      `${endpoint}/oauth2/token`,
      form([
        ["grant_type", "authorization_code"],
        ["code", outcome.code],
        ["client_id", clientId],
        ["redirect_uri", server.redirectUri],
        ["code_verifier", verifier],
      ]),
      TOKEN_TIMEOUT_MS,
    )

    const tokens =
      unreachable(exchanged) || !exchanged.ok
        ? undefined
        : Option.getOrUndefined(decodeTokens(await exchanged.text()))

    if (tokens === undefined) {
      rememberClient(endpoint, undefined, env)

      throw new PhoenixLoginError(
        "failed",
        `Phoenix did not complete the login (${unreachable(exchanged) ? exchanged : `HTTP ${exchanged.status}`}).`,
      )
    }

    const created = await request(
      `${endpoint}/v1/user/api_keys`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
        body: JSON.stringify({ data: { name: options.keyName, description: options.keyDescription } }),
      },
      TOKEN_TIMEOUT_MS,
    )

    const key =
      unreachable(created) || !created.ok
        ? undefined
        : Option.getOrUndefined(decodeCreatedKey(await created.text()))?.data.key

    // The grant has done its job, or failed at it: either way only the key should remain.
    await request(
      `${endpoint}/oauth2/revoke`,
      form([["token", tokens.refresh_token ?? tokens.access_token]]),
      REVOKE_TIMEOUT_MS,
    )

    if (key === undefined)
      throw new PhoenixLoginError(
        "failed",
        `Logged in, but Phoenix did not create an API key (${unreachable(created) ? created : `HTTP ${created.status}`}).`,
      )

    return key
  }

  const key = finish()

  // Settled by whoever awaits it; a login nobody awaits must not be an unhandled rejection.
  key.catch(() => undefined)

  return {
    url: authorize.toString(),
    key,
    cancel: () => settle(new PhoenixLoginError("cancelled", "The Phoenix login was cancelled.")),
    paste: (redirectUrl) => {
      const text = redirectUrl.trim()

      if (!URL.canParse(text)) return "That is not a URL. Copy the whole address the browser ended on."

      const result = returnedWith(new URL(text).searchParams, state)

      if (result.kind === "invalid") return `That address cannot be used. ${result.why}`

      settle(result)

      return undefined
    },
  }
}

/**
 * Sign in with ChatGPT, to use a ChatGPT plan's allowance instead of an API
 * key. OpenAI offers this to open-source projects and personal tools that run
 * locally: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
 *
 * The flow is OAuth 2.0 with PKCE against OpenAI's OpenID provider. The first
 * sign-in registers this app dynamically (`client_id=dynamic_agent_client`);
 * the client id OpenAI issues comes back on the callback and is reused. The
 * access token then works against the public API at `api.openai.com/v1`.
 *
 * Tokens are kept in the keychain, never in config or session files. Refresh
 * tokens rotate: every refresh stores the new one before it is used.
 */
import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { Option, Schema } from "effect"
import { deleteSecret, getSecret, setSecret } from "./secrets.ts"

const ISSUER = "https://auth.openai.com"
const RESOURCE = "https://api.openai.com/v1"
const PLAN_SCOPE = "chatgpt.tokens.use.direct"
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
const CALLBACK_PATH = "/auth/callback"

/** Tried first so a later sign-in uses the same redirect; any free port works otherwise. */
const PREFERRED_PORT = 1458
const ACCOUNT = "chatgpt"
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000

const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  revocation_endpoint: Schema.optionalKey(Schema.String),
})

type Discovery = typeof Discovery.Type

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Finite,
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
})

type TokenResponse = typeof TokenResponse.Type

const OAuthError = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
})

const IdClaims = Schema.Struct({
  sub: Schema.String,
  email: Schema.optionalKey(Schema.String),
  nonce: Schema.optionalKey(Schema.String),
})

/** What the keychain holds for a ChatGPT sign-in. */
const Stored = Schema.Struct({
  client_id: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
  /** Milliseconds since the epoch. */
  expires_at: Schema.Finite,
  subject: Schema.String,
  email: Schema.optionalKey(Schema.String),
})

type Stored = typeof Stored.Type

const parseDiscovery = Schema.decodeUnknownOption(Schema.fromJsonString(Discovery))
const parseToken = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse))
const parseOAuthError = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthError))
const parseClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdClaims))
const parseStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))
const encodeStored = Schema.encodeSync(Stored)

export class ChatGPTError extends Error {}

const random = (): string => randomBytes(32).toString("base64url")

const discover = async (): Promise<Discovery> => {
  const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, { redirect: "error" })
  const discovery = Option.getOrUndefined(parseDiscovery(await response.text()))

  // Every endpoint must belong to the issuer, so a tampered document cannot redirect tokens.
  const endpoints = [
    discovery?.authorization_endpoint,
    discovery?.token_endpoint,
    discovery?.revocation_endpoint,
  ]

  const trusted = endpoints.every(
    (url) => url === undefined || (URL.canParse(url) && new URL(url).origin === ISSUER),
  )

  if (!response.ok || discovery === undefined || discovery.issuer !== ISSUER || !trusted)
    throw new ChatGPTError("Could not read ChatGPT's sign-in configuration. Try again shortly.")

  return discovery
}

const tokenRequest = async (
  discovery: Discovery,
  fields: ReadonlyArray<[string, string]>,
): Promise<TokenResponse> => {
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams([...fields]),
    redirect: "error",
  })

  const text = await response.text()

  if (!response.ok) {
    const error = Option.getOrUndefined(parseOAuthError(text))

    throw new ChatGPTError(
      error?.error === "invalid_grant"
        ? "Your ChatGPT sign-in has expired. Sign in again with /provider login."
        : `ChatGPT sign-in failed: ${error?.error_description ?? error?.error ?? `HTTP ${response.status}`}`,
    )
  }

  const token = Option.getOrUndefined(parseToken(text))

  if (token === undefined || token.token_type.toLowerCase() !== "bearer")
    throw new ChatGPTError("ChatGPT returned an unexpected token response.")

  return token
}

/**
 * The ID token's claims. Its signature is not checked: it came straight from
 * the token endpoint over TLS, which OpenID Connect Core (3.1.3.7) accepts in
 * place of a signature check, and it is used only to name the account.
 */
const claimsOf = (idToken: string | undefined) => {
  const payload = idToken?.split(".")[1]

  return payload === undefined
    ? undefined
    : Option.getOrUndefined(parseClaims(Buffer.from(payload, "base64url").toString("utf8")))
}

const read = (): Stored | undefined => {
  const text = getSecret(ACCOUNT)

  return text === undefined ? undefined : Option.getOrUndefined(parseStored(text))
}

const save = (stored: Stored): void => {
  if (!setSecret(ACCOUNT, JSON.stringify(encodeStored(stored))))
    throw new ChatGPTError("Could not store the ChatGPT sign-in in the keychain.")
}

/** The signed-in account's email (or subject), if signed in. */
export const chatgptAccount = (): string | undefined => {
  const stored = read()

  return stored === undefined ? undefined : (stored.email ?? stored.subject)
}

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.off("error", reject)

      const address = server.address()

      resolve(address !== null && !Schema.is(Schema.String)(address) ? address.port : port)
    })
  })

const PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>oi-agent</title><body style="font:16px system-ui;max-width:32rem;margin:20vh auto"><h1>${message}</h1><p>You can close this tab and return to the terminal.</p>`

interface Callback {
  readonly code: string
  readonly clientId: string
}

/** Opens a URL in the default browser. Failure is fine: the URL is also shown to the user. */
const OPENERS = new Map<string, readonly [string, ReadonlyArray<string>]>([
  ["darwin", ["open", []]],
  ["win32", ["cmd", ["/c", "start", ""]]],
])

/** Opens a URL in the default browser. Failure is fine: the URL is also shown to the user. */
export const openBrowser = (url: string): void => {
  const [command, args] = OPENERS.get(process.platform) ?? ["xdg-open", []]

  execFile(command, [...args, url], () => undefined)
}

export interface SignInOptions {
  /** Called with the authorization URL, to open it and show it. */
  readonly onUrl: (url: string) => void
  readonly signal?: AbortSignal | undefined
}

/** Sign in with ChatGPT in the browser. Resolves to the account's email. */
export const chatgptSignIn = async (options: SignInOptions): Promise<string> => {
  const discovery = await discover()
  const previous = read()
  const state = random()
  const nonce = random()
  const verifier = random()

  let settle: (callback: Callback | Error) => void = () => undefined
  const result = new Promise<Callback | Error>((resolve) => (settle = resolve))

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")

    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end()

      return
    }

    const code = url.searchParams.get("code")
    const clientId = url.searchParams.get("client_id") ?? previous?.client_id
    const error = url.searchParams.get("error")

    const ok =
      error === null && url.searchParams.get("state") === state && code !== null && clientId !== undefined

    response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
    response.end(PAGE(ok ? "Signed in to ChatGPT" : "ChatGPT sign-in did not complete"))

    if (ok && clientId !== "dynamic_agent_client") settle({ code, clientId })
    else
      settle(
        new ChatGPTError(
          error === null ? "ChatGPT sign-in did not complete." : `ChatGPT sign-in failed: ${error}`,
        ),
      )
  })

  const port = await listen(server, PREFERRED_PORT).catch(() => listen(server, 0))
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const timer = setTimeout(() => settle(new ChatGPTError("ChatGPT sign-in timed out.")), SIGN_IN_TIMEOUT_MS)

  options.signal?.addEventListener("abort", () => settle(new ChatGPTError("ChatGPT sign-in was cancelled.")))

  try {
    const authorize = new URL(discovery.authorization_endpoint)

    authorize.search = new URLSearchParams({
      client_id: previous?.client_id ?? "dynamic_agent_client",
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      agent_name_hint: "oi-agent",
    }).toString()

    options.onUrl(authorize.toString())

    const callback = await result

    if (callback instanceof Error) throw callback

    const token = await tokenRequest(discovery, [
      ["grant_type", "authorization_code"],
      ["client_id", callback.clientId],
      ["code", callback.code],
      ["code_verifier", verifier],
      ["redirect_uri", redirectUri],
      ["resource", RESOURCE],
    ])

    const claims = claimsOf(token.id_token)

    if (claims === undefined || claims.nonce !== nonce)
      throw new ChatGPTError("ChatGPT returned an identity that does not match this sign-in.")

    if (token.refresh_token === undefined || !(token.scope ?? "").split(/\s+/).includes(PLAN_SCOPE))
      throw new ChatGPTError("ChatGPT plan usage was not granted. Sign in again and allow it.")

    const stored: Stored = {
      client_id: callback.clientId,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
      subject: claims.sub,
    }

    save(claims.email === undefined ? stored : { ...stored, email: claims.email })

    return claims.email ?? claims.sub
  } finally {
    clearTimeout(timer)
    server.close()
  }
}

let refreshing: Promise<string> | undefined

const refresh = async (stored: Stored): Promise<string> => {
  const discovery = await discover()

  try {
    const token = await tokenRequest(discovery, [
      ["grant_type", "refresh_token"],
      ["client_id", stored.client_id],
      ["refresh_token", stored.refresh_token],
      ["resource", RESOURCE],
    ])

    save({
      ...stored,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? stored.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
    })

    return token.access_token
  } catch (error) {
    // Another oi process may have rotated the refresh token first; use what it stored.
    const latest = read()

    if (
      latest !== undefined &&
      latest.refresh_token !== stored.refresh_token &&
      latest.expires_at > Date.now()
    )
      return latest.access_token

    throw error
  }
}

/** A current access token for ChatGPT plan usage, refreshed when it is about to expire. */
export const chatgptToken = async (): Promise<string> => {
  const stored = read()

  if (stored === undefined) throw new ChatGPTError("Not signed in to ChatGPT. Run /provider login.")

  if (stored.expires_at - REFRESH_MARGIN_MS > Date.now()) return stored.access_token

  refreshing ??= refresh(stored).finally(() => (refreshing = undefined))

  return refreshing
}

/** Sign out: revoke the refresh token (best effort) and forget the sign-in. */
export const chatgptSignOut = async (): Promise<boolean> => {
  const stored = read()

  if (stored === undefined) return false

  const discovery = await discover().catch(() => undefined)

  if (discovery?.revocation_endpoint !== undefined) {
    await fetch(discovery.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["token", stored.refresh_token],
        ["token_type_hint", "refresh_token"],
        ["client_id", stored.client_id],
      ]),
      redirect: "error",
    }).catch(() => undefined)
  }

  return deleteSecret(ACCOUNT)
}

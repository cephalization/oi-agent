/**
 * Model providers from the terminal's side: credentials, model lists, and the
 * model layer for the current settings.
 *
 * Provider entries live in config; API keys and the ChatGPT sign-in live in
 * the keychain. Config is re-read on use, so a provider added with
 * `/provider add` is available at once.
 */
import {
  allProviders,
  anthropicModel,
  chatgptAccount,
  chatgptSignIn,
  chatgptSignOut,
  chatgptToken,
  checkModel,
  type Config,
  deleteSecret,
  findProvider,
  getSecret,
  listModels,
  listOpenAIModels,
  loadConfig,
  type ModelLayer,
  type ModelOption,
  describeModels,
  OPENAI_BASE_URL,
  openaiEfforts,
  openaiModel,
  type ProviderConfig,
  parseModelIds,
  providerIdFrom,
  saveProviders,
  secretAccount,
  setSecret,
} from "@oi-agent/engine"
import { fitEffort } from "./tui/modes.ts"

/** How long a provider may take to list its models before it is skipped. */
const LIST_TIMEOUT_MS = 8000

export interface ProviderStatus {
  readonly provider: ProviderConfig
  /** "key set", "signed in as …", "no key", … */
  readonly credentials: string
  /** Models listed, or why listing failed. */
  readonly models: string
}

/** What the user fills in to add or change an OpenAI-compatible server. */
export interface ServerForm {
  /** Shown in lists; the provider id is made from it. */
  readonly name: string
  readonly baseUrl: string
  /** Empty when the server needs none, or to keep the stored one. */
  readonly key: string
  /** Comma-separated model ids. Empty to use the server's own list. */
  readonly models: string
}

const withTimeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref()),
  ])

export class Providers {
  /** Every model listed so far, across providers. */
  readonly catalog: Array<ModelOption> = []
  private readonly errors = new Map<string, string>()
  /** Told of every key stored, so tool output can be scrubbed of it. */
  onKey: (key: string) => void = () => undefined

  /** Providers from config, re-read so additions show up at once. */
  configured(): ReadonlyArray<ProviderConfig> {
    return loadConfig().providers
  }

  all(): Array<ProviderConfig> {
    return allProviders(this.configured())
  }

  find(id: string): ProviderConfig | undefined {
    return findProvider(this.configured(), id)
  }

  key(provider: ProviderConfig): string | undefined {
    return provider.kind === "chatgpt" ? undefined : getSecret(secretAccount(provider))
  }

  /** Every API key in use, for the redactor. */
  keys(): Array<string> {
    return this.all().flatMap((provider) => this.key(provider) ?? [])
  }

  /** Whether a provider can be used now. Compatible servers may need no key. */
  usable(provider: ProviderConfig): boolean {
    if (provider.kind === "chatgpt") return chatgptAccount() !== undefined

    return provider.kind === "openai-compatible" || this.key(provider) !== undefined
  }

  private credentials(provider: ProviderConfig): string {
    if (provider.kind === "chatgpt") {
      const account = chatgptAccount()

      return account === undefined ? "not signed in" : `signed in as ${account}`
    }

    if (this.key(provider) !== undefined) return "key set"

    return provider.kind === "openai-compatible" ? "no key" : "no key yet"
  }

  status(): Array<ProviderStatus> {
    return this.all().map((provider) => {
      const count = this.catalog.filter((model) => model.provider === provider.id).length
      const error = this.errors.get(provider.id)

      return {
        provider,
        credentials: this.credentials(provider),
        models: error ?? (count === 0 ? "" : `${count} model${count === 1 ? "" : "s"}`),
      }
    })
  }

  private async list(provider: ProviderConfig): Promise<Array<ModelOption>> {
    // A server with models of its own in config offers just those.
    if (provider.models !== undefined && provider.models.length > 0)
      return provider.models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        provider: provider.id,
        efforts: [],
        maxOutput: model.max_output,
      }))

    if (provider.kind === "anthropic") return listModels(this.key(provider) ?? "")

    const token = provider.kind === "chatgpt" ? await chatgptToken() : this.key(provider)

    return listOpenAIModels({
      provider: provider.id,
      baseUrl: provider.base_url ?? OPENAI_BASE_URL,
      token,
      openaiCatalog: provider.kind !== "openai-compatible",
    })
  }

  /** List the models of one provider, or of every usable one. Failures are kept for `/provider`. */
  async refresh(id?: string): Promise<void> {
    const targets = this.all().filter(
      (provider) => (id === undefined || provider.id === id) && this.usable(provider),
    )

    await Promise.all(
      targets.map(async (provider) => {
        try {
          const models = await withTimeout(this.list(provider), LIST_TIMEOUT_MS)

          this.errors.delete(provider.id)
          this.replace(provider.id, models)
        } catch (error) {
          this.errors.set(
            provider.id,
            `could not list models: ${error instanceof Error ? error.message : String(error)}`,
          )
          this.replace(provider.id, [])
        }
      }),
    )
  }

  private replace(provider: string, models: ReadonlyArray<ModelOption>): void {
    const kept = this.catalog.filter((model) => model.provider !== provider)

    this.catalog.splice(0, this.catalog.length, ...kept, ...models)
  }

  /** The model layer for these settings. Throws when the provider is unknown or has no credentials. */
  modelFor(settings: Config): ModelLayer {
    const provider = this.find(settings.provider)

    if (provider === undefined)
      throw new Error(`No provider named ${settings.provider}. /provider lists them.`)

    if (provider.kind === "anthropic") {
      const apiKey = this.key(provider)

      if (apiKey === undefined) throw new Error("No Anthropic API key. Add one with /provider key anthropic.")

      return anthropicModel({
        model: settings.model,
        effort: settings.effort,
        maxTokens: settings.max_tokens,
        apiKey,
      })
    }

    const key = this.key(provider)

    if (provider.kind === "openai" && key === undefined)
      throw new Error(
        "No OpenAI API key. Add one with /provider key openai, or use your ChatGPT plan: /provider login.",
      )

    if (provider.kind === "chatgpt" && chatgptAccount() === undefined)
      throw new Error("Not signed in to ChatGPT. Run /provider login.")

    // Only OpenAI's reasoning models take an effort; other servers get none.
    const levels = provider.kind === "openai-compatible" ? [] : openaiEfforts(settings.model)

    // Ask for no more than the model can write; servers reject a larger max_tokens.
    const limit =
      provider.models?.find((model) => model.id === settings.model)?.max_output ??
      this.catalog.find((model) => model.provider === provider.id && model.id === settings.model)?.maxOutput

    return openaiModel({
      provider: provider.id,
      api: provider.api ?? (provider.kind === "openai-compatible" ? "chat" : "responses"),
      baseUrl: provider.base_url ?? OPENAI_BASE_URL,
      model: settings.model,
      effort: fitEffort(settings.effort, levels),
      maxTokens: Math.min(settings.max_tokens, limit ?? settings.max_tokens),
      token: provider.kind === "chatgpt" ? chatgptToken : () => Promise.resolve(key),
      onUnauthorized:
        provider.kind === "chatgpt"
          ? "Sign in again with /provider login."
          : `Replace the key with /provider key ${provider.id}.`,
    })
  }

  /** Confirm a model the list does not include. Resolves to a display name. */
  async check(provider: string, model: string): Promise<string> {
    const config = this.find(provider)

    if (config === undefined) throw new Error(`No provider named ${provider}.`)

    if (config.kind === "anthropic") return checkModel(this.key(config) ?? "", model)

    // Most OpenAI-style servers cannot look up one model; an unknown id fails on the first turn instead.
    return model
  }

  // --- managing providers ------------------------------------------------------

  /**
   * Add an OpenAI-compatible server, or change one (`id`). The server is asked
   * for its models so the names and output limits of the ones listed can be
   * saved too; it need not answer. Resolves to the provider id.
   */
  async saveServer(form: ServerForm, id?: string): Promise<string> {
    const name = form.name.trim()
    const baseUrl = form.baseUrl.trim().replace(/\/+$/, "")
    const existing = id === undefined ? undefined : this.configured().find((entry) => entry.id === id)
    const target = existing?.id ?? providerIdFrom(name)

    if (id !== undefined && existing === undefined) throw new Error(`No added provider named ${id}.`)

    if (target === undefined) throw new Error("The name needs a letter or a digit.")

    if (existing === undefined && this.find(target) !== undefined)
      throw new Error(`There is already a provider named ${target}. Pick another name.`)

    if (!URL.canParse(baseUrl) || !/^https?:$/.test(new URL(baseUrl).protocol))
      throw new Error(
        `${baseUrl} is not an http(s) URL. It should be the API root, like http://localhost:11434/v1.`,
      )

    const key = form.key.trim()

    if (key !== "") {
      const failed = this.setKey(target, key, true)

      if (failed !== undefined) throw new Error(failed)
    }

    const ids = parseModelIds(form.models)

    const listed =
      ids.length === 0
        ? []
        : await withTimeout(
            listOpenAIModels({
              provider: target,
              baseUrl,
              token: key === "" ? getSecret(`provider:${target}`) : key,
              openaiCatalog: false,
            }),
            LIST_TIMEOUT_MS,
          ).catch(() => [])

    const server: ProviderConfig = {
      id: target,
      name: name === "" ? target : name,
      kind: "openai-compatible",
      base_url: baseUrl,
    }

    const saved = ids.length === 0 ? server : { ...server, models: describeModels(ids, listed) }

    saveProviders([...this.configured().filter((entry) => entry.id !== target), saved])

    return target
  }

  /** Remove an added provider and its key. Built-in providers cannot be removed. */
  remove(id: string): string | undefined {
    const provider = this.configured().find((entry) => entry.id === id)

    if (provider === undefined)
      return this.find(id) === undefined
        ? `No provider named ${id}.`
        : `${id} is built in; it cannot be removed.`

    saveProviders(this.configured().filter((entry) => entry.id !== id))
    deleteSecret(secretAccount(provider))
    this.replace(id, [])

    return undefined
  }

  /** Store a provider's API key. `unsaved` allows a server not yet in config. */
  setKey(id: string, key: string, unsaved = false): string | undefined {
    const provider: ProviderConfig | undefined =
      this.find(id) ?? (unsaved ? { id, name: id, kind: "openai-compatible" } : undefined)

    if (provider === undefined) return `No provider named ${id}.`

    if (provider.kind === "chatgpt") return "ChatGPT uses sign-in, not a key."

    this.onKey(key)

    return setSecret(secretAccount(provider), key) ? undefined : "The keychain did not accept the key."
  }

  /** Forget a key, or sign out of ChatGPT. */
  async forget(id: string): Promise<string | undefined> {
    const provider = this.find(id)

    if (provider === undefined) return `No provider named ${id}.`

    const done = provider.kind === "chatgpt" ? await chatgptSignOut() : deleteSecret(secretAccount(provider))

    this.replace(id, [])

    return done ? undefined : `${id} had no key or sign-in to remove.`
  }

  /** Sign in with ChatGPT in the browser. Resolves to the account. */
  login(onUrl: (url: string) => void, signal?: AbortSignal): Promise<string> {
    return chatgptSignIn({ onUrl, signal })
  }
}

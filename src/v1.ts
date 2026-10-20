// opencode 1 adapter (`server`): injects the Copilot Auto models into the provider's
// model list and routes each conversation through POST /auto, like VS Code. Routing
// lives in core.ts.
import type { Plugin } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import {
  type AutoSpec,
  type CatalogModel,
  type Options,
  PLUGIN_ID,
  PROVIDER_ID,
  type Route,
  type Wire,
  fetchAutoDecision,
  log,
  pickRoute,
  resolveAutos,
  routeUsable,
} from "./core"

// Everything tracked per opencode session and auto: the pinned route plus whether the
// next agent turn has to route again.
type ConvState = {
  route?: Route
  routing?: Promise<Route>
  needsReEval?: boolean
  // The prompt a routing round last failed for (no Auto session); the next attempt
  // waits for the next user prompt instead of stalling every tool step.
  failedFor?: object
}

// opencode's github-copilot provider sends GPT-5+ (except gpt-5-mini) over the
// Responses API and everything else over Chat Completions; Claude goes through the
// Anthropic SDK.
function wireOf(api: { id: string; npm: string }): Wire {
  if (api.npm === "@ai-sdk/anthropic") return "messages"
  const match = /^gpt-(\d+)/.exec(api.id)
  return match && Number(match[1]) >= 5 && !api.id.startsWith("gpt-5-mini") ? "responses" : "chat"
}

export function toCatalogModel(model: Model): CatalogModel {
  return {
    key: model.id,
    apiID: model.api.id,
    name: model.name,
    family: model.family,
    transport: `${model.api.npm} ${model.api.url}`,
    wire: wireOf(model.api),
    enabled: true,
    vision: model.capabilities?.input?.image ?? model.capabilities?.attachment ?? true,
  }
}

// POST /auto lives on the CAPI root; Claude anchors point at its /v1.
function capiBase(url: string) {
  const clean = url.replace(/\/+$/, "")
  return clean.endsWith("/v1") ? clean.slice(0, -3) : clean
}

// Private header chat.headers uses to tell the fetch wrapper which model to send.
const ROUTE_HEADER = "x-copilot-auto-route"
const FETCH_WRAPPED = Symbol.for(`${PLUGIN_ID}.fetch`)

// opencode builds the auto's language model once, from the anchor's api.id, and its
// Copilot/Anthropic SDKs take the request's model from that — they drop a `model`
// passed through chat.params options. So the routed id travels in a private header
// and is swapped into the JSON body here, just before the request leaves.
function rewriteRoutedRequest(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init
  const headers = new Headers(init.headers)
  const model = headers.get(ROUTE_HEADER)
  if (!model) return init
  headers.delete(ROUTE_HEADER)
  let body = init.body
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { model?: unknown }
      if (typeof parsed.model === "string" && parsed.model !== model) {
        log(`request model ${parsed.model} -> ${model}`)
        parsed.model = model
        body = JSON.stringify(parsed)
      }
    } catch {
      /* not JSON: send as-is */
    }
  }
  return { ...init, headers, body }
}

// The Copilot auth loader and the SDKs resolve the global fetch per call, so one
// wrapper sees every outgoing request; it only acts on requests carrying ROUTE_HEADER.
function installRouteFetch() {
  const current = globalThis.fetch as typeof fetch & { [FETCH_WRAPPED]?: true }
  if (current[FETCH_WRAPPED]) return
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => current(input, rewriteRoutedRequest(init))
  globalThis.fetch = Object.assign(wrapped, current, { [FETCH_WRAPPED]: true }) as unknown as typeof fetch
}

type TextPart = { type: string; text?: string; synthetic?: boolean; ignored?: boolean; mime?: string }

export const server: Plugin = async ({ client }, options) => {
  const opts = (options ?? {}) as Options
  installRouteFetch()

  let bearer: string | undefined
  let models: Model[] = []
  let catalog: CatalogModel[] = []
  let autos = new Map<string, AutoSpec>()
  const prompts = new Map<string, { text: string; hasImage: boolean }>()
  const conversations = new Map<string, Map<string, ConvState>>()

  const modelByAPIID = (apiID: string) => models.find((m) => m.api.id === apiID)

  function getConv(sessionID: string, autoID: string): ConvState {
    let sessionAutos = conversations.get(sessionID)
    if (!sessionAutos) {
      sessionAutos = new Map()
      conversations.set(sessionID, sessionAutos)
    }
    let conv = sessionAutos.get(autoID)
    if (!conv) {
      conv = {}
      sessionAutos.set(autoID, conv)
    }
    return conv
  }

  // One routing round through POST /auto.
  async function resolveRoute(sessionID: string, auto: AutoSpec, hasImage: boolean): Promise<Route> {
    const prompt = prompts.get(sessionID)
    const anchor = models.find((m) => m.id === auto.anchor.key)
    const session =
      bearer && prompt?.text && anchor
        ? await fetchAutoDecision(capiBase(anchor.api.url), bearer, prompt.text, auto.tier, hasImage)
        : undefined
    // As VS Code: when routing fails, keep the last route while it can still serve
    // the turn, and route again on the next one.
    const previous = getConv(sessionID, auto.id).route
    if (!session && previous?.sessionToken && routeUsable(previous, catalog, hasImage)) {
      log(`${auto.id}: routing failed, keeping ${previous.modelID} for ${sessionID}`)
      return previous
    }
    // The catalog may have been rebuilt while /auto answered; judge the pick against
    // the current auto and catalog.
    return pickRoute(autos.get(auto.id) ?? auto, session, catalog, hasImage)
  }

  // Show the routed model, as VS Code and Copilot CLI do per response: a transient
  // toast whenever the model is (re)picked. Fire-and-forget; never let it break a turn.
  const toast = (message: string, variant: "info" | "warning") => {
    try {
      void Promise.resolve(client.tui.showToast({ body: { message, variant } })).catch(() => {})
    } catch {
      /* ignore */
    }
  }

  return {
    // After compaction the conversation shape changed, so route again on the next
    // turn (mirrors VS Code's invalidateRouterCache).
    event: async ({ event }) => {
      if (event.type !== "session.compacted") return
      const sessionAutos = conversations.get(event.properties.sessionID)
      if (!sessionAutos?.size) return
      for (const conv of sessionAutos.values()) conv.needsReEval = true
      log(`route invalidated by compaction for ${event.properties.sessionID}`)
    },
    // Capture what the user typed; only POST /auto sees it. Synthetic parts (file
    // contents, reminders) are opencode's additions, not the user's prompt.
    "chat.message": async (input, output) => {
      const parts = output.parts as TextPart[]
      const text = parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim()
      const hasImage = parts.some((p) => p.type === "file" && (p.mime ?? "").startsWith("image/"))
      prompts.set(input.sessionID, { text, hasImage })
    },
    "chat.params": async (incoming, output) => {
      if (incoming.model.providerID !== PROVIDER_ID) return
      const auto = autos.get(incoming.model.id)
      if (!auto) return
      const conv = getConv(incoming.sessionID, auto.id)
      // Route once per conversation and stick with it so the model — and its prompt
      // KV cache — stays stable, as VS Code does. Route again after compaction, when
      // the token is about to expire, when the turn attaches an image the model
      // cannot read, or after a failed round.
      const prompt = prompts.get(incoming.sessionID)
      const hasImage = !!prompt?.hasImage
      const route = conv.route
      const waitForPrompt = !!route && !!prompt && conv.failedFor === prompt
      if (!route || (!waitForPrompt && (conv.needsReEval || !routeUsable(route, catalog, hasImage)))) {
        conv.routing ??= resolveRoute(incoming.sessionID, auto, hasImage).finally(() => {
          conv.routing = undefined
        })
        const next = await conv.routing
        if (next.modelID !== route?.modelID)
          toast(
            `${auto.name} → ${next.modelID}${next.sessionToken ? "" : " · no Auto session"}`,
            next.sessionToken ? "info" : "warning",
          )
        // A kept route leaves a pending re-evaluation in place for the next turn.
        if (next !== route) conv.needsReEval = false
        conv.failedFor = next.sessionToken && next !== route ? undefined : prompt
        conv.route = next
      }

      // The model itself is swapped in by the fetch wrapper (see chat.headers).
      const decided = modelByAPIID(conv.route!.modelID)
      log(`chat.params route ${auto.id} -> ${conv.route!.modelID}`)
      // opencode sized the params for the anchor; the routed model may reject
      // temperature (e.g. gpt-6-luna 400s with "not supported"). opencode itself passes
      // undefined for such models, despite the hook's `number` type.
      if (decided?.capabilities?.temperature === false && output.temperature !== undefined) {
        ;(output as { temperature?: number }).temperature = undefined
        log(`temperature dropped for ${decided.api.id}`)
      }
    },
    "chat.headers": async (incoming, output) => {
      if (incoming.model.providerID !== PROVIDER_ID) return
      const auto = autos.get(incoming.model.id)
      if (!auto) return
      const route = getConv(incoming.sessionID, auto.id).route
      if (!route) return
      output.headers[ROUTE_HEADER] = route.modelID
      if (route.sessionToken) output.headers["Copilot-Session-Token"] = route.sessionToken
    },
    provider: {
      id: PROVIDER_ID,
      // No network here: POST /auto needs a prompt, so routing happens per turn.
      async models(provider, ctx) {
        bearer = ctx.auth?.type === "oauth" ? ctx.auth.refresh : undefined
        models = Object.values(provider.models).filter((m) => m.providerID === PROVIDER_ID)
        catalog = models.map(toCatalogModel)
        const resolved = resolveAutos(opts, catalog)
        autos = new Map(resolved.map((auto) => [auto.id, auto]))
        const injected = { ...provider.models }
        for (const auto of resolved) {
          if (injected[auto.id]) {
            log(`skip inject ${auto.id}: model id already exists`)
            autos.delete(auto.id)
            continue
          }
          const template = models.find((m) => m.id === auto.anchor.key)!
          // Copy the anchor's api (id, npm, url) as-is: it already points at the right
          // endpoint (keep /v1 for Claude: the Anthropic SDK appends /messages).
          injected[auto.id] = { ...template, id: auto.id, name: auto.name, family: "github-copilot-auto", variants: undefined }
          log(`injected ${auto.id} (${auto.name}, tier=${auto.tier}) -> ${template.api.id} (${auto.anchor.transport}, ${auto.anchor.wire})`)
        }
        return injected
      },
    },
  }
}

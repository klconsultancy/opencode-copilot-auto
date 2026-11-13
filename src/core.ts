// Copilot Auto routing, independent of opencode's plugin API: tiers, the POST /auto
// call, which autos to inject and which server pick an auto can actually send.
// Mirrors VS Code's Copilot Auto (extensions/copilot/src/platform/endpoint in
// microsoft/vscode: automodeService.ts, autoV2Fetcher.ts, autoModeTiers.ts).
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const PLUGIN_ID = "opencode-copilot-auto"
export const PROVIDER_ID = "github-copilot"
export const MODEL_ID = "auto"
export const DEFAULT_BASE_URL = "https://api.githubcopilot.com"

// Matches `@vscode/copilot-api` 0.5.x (`_mixinHeaders`) and opencode's own Copilot provider.
// No editor or integration headers: POST /auto answers without them, and they would
// impersonate VS Code.
const COPILOT_API_VERSION = "2026-08-01"

// VS Code's AutoV2Fetcher aborts POST /auto after 5s.
const AUTO_TIMEOUT_MS = 5000

// VS Code renews an auto session this long before its server expiry, so a long
// request cannot outlive its token.
export const SESSION_REFRESH_SKEW_MS = 5 * 60_000

// Routing profiles accepted by POST /auto. A tier is picked per conversation and
// biases which models the router may choose from; it is not sent to the model.
export const AUTO_TIERS = ["efficiency", "balance", "intelligence", "fast"] as const
export type AutoTier = (typeof AUTO_TIERS)[number]
// The tiers VS Code's Auto picker and Copilot CLI's /model offer. `fast` is VS Code's
// internal inline-chat default and was dropped from Copilot CLI (1.0.89), where a
// stored `fast` falls back to balance; so does it here.
export const PICKER_TIERS: readonly AutoTier[] = ["efficiency", "balance", "intelligence"]
export const DEFAULT_TIER: AutoTier = "balance"
// Retired names the server still accepts; VS Code maps them forward on read.
const RETIRED_TIERS: Record<string, AutoTier> = { eco: "efficiency", balanced: "balance", max: "intelligence" }

// Request body shape a model is sent with. Picks on another wire API cannot be sent
// through an auto's endpoint: the bodies differ.
export type Wire = "responses" | "chat" | "messages"

// A Copilot model as routing needs it, independent of opencode's model shape.
export type CatalogModel = {
  // opencode's model id (the picker key).
  key: string
  // The id Copilot's API knows; POST /auto answers with these.
  apiID: string
  name: string
  family?: string
  // Models sharing a transport are sent by the same SDK to the same base URL.
  transport: string
  wire: Wire
  enabled: boolean
  // Accepts image input. A turn with an image needs a vision model.
  vision: boolean
}

export type Options = {
  // Tier of the main `auto` model (efficiency | balance | intelligence), like Copilot
  // CLI's startup default. The other picker tiers get their own auto next to it.
  tier?: string
  // Ordered list of model keys or API ids to anchor the autos on. The anchor's
  // endpoint carries every request an auto sends, and it is the fallback model.
  preferredModels?: string[]
  // Experimental, opencode 2 only: adds `auto-cascade`, an efficiency-tier auto whose
  // turns a judge model reviews (see cascade.ts). `true`, or `{ judge, draft }` to name the
  // judge by model key or API id; `draft` pins the draft to one model instead of /auto
  // (for measuring the judge on weak drafts).
  cascade?: boolean | { judge?: string; draft?: string }
}

// An auto as injected into the picker: cloned from its anchor model, whose endpoint
// carries every request it sends.
export type AutoSpec = {
  id: string
  name: string
  tier: AutoTier
  anchor: CatalogModel
  // Skip POST /auto and always send the anchor (the cascade's test-only `draft`).
  pinned?: boolean
}

// A POST /auto result: the model it picked plus the session token that places chat
// requests in Copilot's Auto pool, where they get the Auto discount.
export type AutoSession = {
  modelID: string
  sessionToken: string
  expiresAtMs: number
}

// Which session flow issued a model request (opencode's SessionRequestKind).
export type ConvKind = "primary" | "compaction" | "title" | "generate"

// The model a conversation is pinned to. `sessionToken` is only set when the server
// routed to that exact model; fallbacks go without it (Copilot rejects a token for a
// model the session did not pick).
export type Route = {
  modelID: string
  sessionToken?: string
  expiresAtMs: number
}

// --- state directory --------------------------------------------------------------------
// ~/.local/state/opencode-copilot-auto (or $XDG_STATE_HOME, %LOCALAPPDATA% on Windows):
// the log and the persisted routes. Resolved per call, so tests can move it.
export function stateDir() {
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), PLUGIN_ID)
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), PLUGIN_ID)
}

// --- logging ----------------------------------------------------------------------------
// File logger — keeps the TUI clean.
// Tail ~/.local/state/opencode-copilot-auto/plugin.log to observe.
function logFile() {
  return path.join(stateDir(), "plugin.log")
}

let logReady: Promise<void> | undefined
export function log(msg: string) {
  const file = logFile()
  logReady ??= mkdir(path.dirname(file), { recursive: true }).then(() => undefined).catch(() => undefined)
  void logReady.then(() => appendFile(file, `${new Date().toISOString()} info ${msg}\n`).catch(() => undefined))
}

// --- configuration ----------------------------------------------------------------------
export function normalizeTier(value: string | undefined): AutoTier {
  const raw = value?.trim().toLowerCase()
  if (!raw) return DEFAULT_TIER
  const tier = RETIRED_TIERS[raw] ?? raw
  if ((PICKER_TIERS as readonly string[]).includes(tier)) return tier as AutoTier
  log(`ignoring tier "${value}" (not one of ${PICKER_TIERS.join(", ")}); using ${DEFAULT_TIER}`)
  return DEFAULT_TIER
}

export function familyLabel(model?: Pick<CatalogModel, "key" | "apiID" | "name" | "family" | "wire">): string | undefined {
  if (!model) return undefined
  const fingerprint = `${model.key} ${model.name} ${model.family ?? ""} ${model.apiID}`.toLowerCase()
  // Fingerprint first: many families share the Copilot transport, so it cannot tell
  // them apart.
  if (fingerprint.includes("claude")) return "Claude"
  if (fingerprint.includes("gemini")) return "Gemini"
  if (fingerprint.includes("microsoft") || fingerprint.includes("mai") || fingerprint.includes("raptor"))
    return "Microsoft"
  if (fingerprint.includes("gpt") || fingerprint.includes("codex")) return "GPT"
  if (model.wire === "messages") return "Claude"
  return undefined
}

function resolvePreferred(catalog: CatalogModel[], preferred: string[] | undefined): CatalogModel | undefined {
  for (const token of preferred ?? []) {
    const key = token.trim()
    const model = catalog.find((m) => m.key === key) ?? catalog.find((m) => m.apiID === key)
    if (model) return model
  }
  return undefined
}

// Autos anchor on a GPT model sent over the Responses API when possible: that is what
// POST /auto picks, so it keeps the picks servable. Catalog order alone could anchor
// on a Chat-only model (gpt-5-mini, kimi-k3) and reject every pick.
function pickAnchor(catalog: CatalogModel[]): CatalogModel | undefined {
  const enabled = catalog.filter((m) => m.enabled)
  const pool = enabled.length ? enabled : catalog
  return pool.find((m) => familyLabel(m) === "GPT" && m.wire === "responses") ?? pool.find((m) => m.wire !== "messages") ?? pool[0]
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

// The picker autos: `auto` on the configured tier, plus one per other picker tier
// (auto-efficiency, auto-intelligence next to a balance `auto`), all on one anchor.
// Picking another one mid-conversation switches the tier, as in VS Code's picker.
export function resolveAutos(options: Options, catalog: CatalogModel[]): AutoSpec[] {
  const anchor = resolvePreferred(catalog, options.preferredModels) ?? pickAnchor(catalog)
  if (!anchor) return []
  const tier = normalizeTier(options.tier)
  return [
    { id: MODEL_ID, name: "Auto", tier, anchor },
    ...PICKER_TIERS.filter((other) => other !== tier).map((other) => ({
      id: `${MODEL_ID}-${other}`,
      name: `Auto ${capitalize(other)}`,
      tier: other,
      anchor,
    })),
  ]
}

// --- routing ----------------------------------------------------------------------------
// Whether an auto can send `apiID`: same transport and wire API as its anchor, whose
// endpoint carries the request, and vision when the turn attaches an image.
export function servable(auto: AutoSpec, apiID: string, catalog: CatalogModel[], hasImage = false): boolean {
  const model = apiID === auto.anchor.apiID ? auto.anchor : catalog.find((m) => m.apiID === apiID)
  if (!model || model.transport !== auto.anchor.transport || model.wire !== auto.anchor.wire) return false
  return !hasImage || model.vision
}

// Whether a pinned route can serve the next turn, as VS Code's _isCacheEntryCompatible:
// its token is not about to expire, and it supports vision if the turn has an image.
export function routeUsable(route: Route, catalog: CatalogModel[], hasImage: boolean): boolean {
  if (Date.now() >= route.expiresAtMs - SESSION_REFRESH_SKEW_MS) return false
  return !hasImage || !!catalog.find((m) => m.apiID === route.modelID)?.vision
}

// Turns a POST /auto result into the route an auto pins its conversation to.
export function pickRoute(auto: AutoSpec, session: AutoSession | undefined, catalog: CatalogModel[], hasImage = false): Route {
  const fallback = auto.anchor.apiID
  // expiresAtMs 0 → nothing to stick to; route again next turn.
  if (!session) return { modelID: fallback, expiresAtMs: 0 }
  if (servable(auto, session.modelID, catalog, hasImage)) {
    log(`${auto.id} routed -> ${session.modelID}`)
    return { modelID: session.modelID, sessionToken: session.sessionToken, expiresAtMs: session.expiresAtMs }
  }
  // The router chose a model this auto cannot send (other endpoint or wire API, no
  // vision for an image turn, or missing from the catalog). VS Code would send it
  // through that model's own endpoint; opencode built the request for the anchor, so
  // stay on the anchor for this session, without the token.
  log(
    `${auto.id}: router picked ${session.modelID}, not servable via ${auto.anchor.transport} (${auto.anchor.wire})${hasImage ? " with vision" : ""}; using ${fallback} without Copilot-Session-Token`,
  )
  return { modelID: fallback, expiresAtMs: session.expiresAtMs }
}

function copilotHeaders(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
  }
}

function expiresAtMs(value: unknown, fallbackMs: number): number {
  return typeof value === "number" ? value * 1000 : Date.now() + fallbackMs
}

// POST /auto — VS Code's Auto (AutoV2Fetcher.ts): routes the prompt, picks one model
// and mints the session token its chat request bills against, in a single call.
export async function fetchAutoDecision(
  baseURL: string,
  bearer: string,
  prompt: string,
  tier: AutoTier,
  hasImage: boolean,
): Promise<AutoSession | undefined> {
  const body: Record<string, unknown> = { prompt, tier }
  if (hasImage) body.has_image = true
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), AUTO_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseURL}/auto`, {
      method: "POST",
      headers: copilotHeaders(bearer),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      log(`auto fetch non-ok: ${response.status} ${text}`)
      return undefined
    }
    const data = (await response.json().catch(() => undefined)) as
      | {
          session_token?: unknown
          expires_at?: unknown
          selected_model?: { id?: unknown }
          hydra_scores?: unknown
          discounted_costs?: unknown
        }
      | undefined
    const modelID = data?.selected_model?.id
    if (!data || typeof data.session_token !== "string" || typeof modelID !== "string") {
      log("auto fetch invalid payload (missing session_token or selected_model.id)")
      return undefined
    }
    log(
      `auto decision: selected_model=${modelID}, tier=${tier}, prompt_chars=${prompt.length}, hydra_scores=${JSON.stringify(data.hydra_scores ?? {})}, discounted_costs=${JSON.stringify(data.discounted_costs ?? {})}`,
    )
    // The token lasts 24h with no refresh flow.
    return {
      modelID,
      sessionToken: data.session_token,
      expiresAtMs: expiresAtMs(data.expires_at, 24 * 60 * 60_000),
    }
  } catch (error) {
    log(`auto fetch failed: ${String(error)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// --- conversations ----------------------------------------------------------------------
// Everything tracked per opencode session and auto: the pinned route plus the inputs
// for the next routing round.
export type ConvState = {
  route?: Route
  routing?: Promise<Route>
  needsReEval?: boolean
  // The prompt a routing round last failed for (no Auto session); the next attempt
  // waits for the next user prompt instead of stalling every tool step.
  failedFor?: object
}

// What survives a reload: the route (with its session token, so the conversation
// stays billed against its Auto session) and a pending re-evaluation.
type StoredConv = Route & { needsReEval?: boolean }
type StoredSessions = Record<string, Record<string, StoredConv>>

// opencode reloads plugins whenever the config changes and recycles idle instances,
// which used to drop every pinned route: the next turn routed again on whatever the
// user typed last and could switch the model mid-conversation, losing its prompt
// cache. VS Code keeps the route per conversation; so do we, across reloads, in
// routes.json next to the log. Entries live as long as their session token (24h).
function routesFile() {
  return path.join(stateDir(), "routes.json")
}

function durable(route: Route | undefined, now = Date.now()): route is Route {
  return !!route && route.expiresAtMs > now
}

async function readRoutes(file: string): Promise<StoredSessions> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { sessions?: unknown }
    return data.sessions && typeof data.sessions === "object" ? (data.sessions as StoredSessions) : {}
  } catch {
    return {}
  }
}

// Writes from this process run one at a time; each re-reads the file, so instances
// for other directories (or other opencode processes) keep their entries.
let routeWrites: Promise<void> = Promise.resolve()

function writeRoute(sessionID: string, autoID: string, entry: StoredConv | undefined): Promise<void> {
  const file = routesFile()
  const write = async () => {
    const sessions = await readRoutes(file)
    const now = Date.now()
    if (entry) (sessions[sessionID] ??= {})[autoID] = entry
    else if (sessions[sessionID]) delete sessions[sessionID][autoID]
    for (const [id, autos] of Object.entries(sessions)) {
      for (const [auto, stored] of Object.entries(autos)) if (!durable(stored, now)) delete autos[auto]
      if (!Object.keys(autos).length) delete sessions[id]
    }
    await mkdir(path.dirname(file), { recursive: true })
    // Holds session tokens: owner-only, replaced atomically.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      await writeFile(tmp, JSON.stringify({ version: 1, sessions }), { mode: 0o600 })
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }
  routeWrites = routeWrites.then(write).catch((error) => log(`route store write failed: ${String(error)}`))
  return routeWrites
}

export class Conversations {
  private live = new Map<string, Map<string, ConvState>>()
  private stored: StoredSessions = {}

  // Reads the routes persisted by earlier instances. Never throws.
  async load() {
    this.stored = await readRoutes(routesFile())
  }

  // The conversation of `auto` in a session. A route persisted before a reload comes
  // back while its token is valid and the auto can still send its model (the anchor
  // or catalog may have changed since).
  get(sessionID: string, auto: AutoSpec, catalog: CatalogModel[]): ConvState {
    let sessionAutos = this.live.get(sessionID)
    if (!sessionAutos) {
      sessionAutos = new Map()
      this.live.set(sessionID, sessionAutos)
    }
    let conv = sessionAutos.get(auto.id)
    if (conv) return conv
    conv = {}
    const stored = this.stored[sessionID]?.[auto.id]
    if (stored) {
      delete this.stored[sessionID][auto.id]
      const { needsReEval, ...route } = stored
      if (durable(route) && servable(auto, route.modelID, catalog)) {
        conv.route = route
        conv.needsReEval = needsReEval
        log(`${auto.id}: restored ${route.modelID} for ${sessionID}`)
      }
    }
    sessionAutos.set(auto.id, conv)
    return conv
  }

  // Persists a conversation after a routing round or an invalidation.
  save(sessionID: string, autoID: string, conv: ConvState): Promise<void> {
    const route = conv.route
    return writeRoute(
      sessionID,
      autoID,
      durable(route) ? { ...route, ...(conv.needsReEval ? { needsReEval: true } : {}) } : undefined,
    )
  }

  // Marks every auto of a session for re-routing on its next agent turn, including
  // routes restored from disk but not used yet. Returns whether there was any.
  async invalidate(sessionID: string): Promise<boolean> {
    const writes: Promise<void>[] = []
    for (const [autoID, conv] of this.live.get(sessionID) ?? []) {
      conv.needsReEval = true
      writes.push(this.save(sessionID, autoID, conv))
    }
    for (const [autoID, stored] of Object.entries(this.stored[sessionID] ?? {})) {
      stored.needsReEval = true
      writes.push(writeRoute(sessionID, autoID, stored))
    }
    await Promise.all(writes)
    return writes.length > 0
  }
}

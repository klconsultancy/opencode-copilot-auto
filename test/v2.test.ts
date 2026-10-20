// opencode 2 adapter (`setup`), against a minimal stand-in for its plugin context.
import { describe, expect, test } from "bun:test"
import plugin from "../src/index"

const COPILOT = "https://api.githubcopilot.com"
const COPILOT_SDK = "aisdk:@ai-sdk/github-copilot"
const ANTHROPIC = "@opencode/ai/providers/anthropic"

type Wire = "responses" | "chat" | "messages"
type FakeModel = {
  id: string
  modelID: string
  providerID: string
  name: string
  family: string
  package: string
  settings: Record<string, unknown>
  enabled: boolean
  variants: unknown[]
}

// Shaped like opencode 2's Copilot catalog (CopilotModels.derive).
const makeModel = (id: string, name: string, family: string, wire: Wire): FakeModel => ({
  id,
  modelID: id,
  providerID: "github-copilot",
  name,
  family,
  package: wire === "messages" ? ANTHROPIC : COPILOT_SDK,
  settings: { baseURL: wire === "messages" ? `${COPILOT}/v1` : COPILOT, endpoint: wire },
  enabled: true,
  variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
})

const sonnet = makeModel("claude-sonnet-5.5", "Claude Sonnet 5.5", "claude-sonnet-5.5", "messages")
const haiku = makeModel("claude-haiku-5.5", "Claude Haiku 5.5", "claude-haiku-5.5", "messages")
const gpt54 = makeModel("gpt-5.4", "GPT-5.4", "gpt-5.4", "responses")
const luna = makeModel("gpt-6-luna", "GPT-6 Luna", "gpt-6-luna", "responses")
const sol = makeModel("gpt-6.1-sol", "GPT-6.1 Sol", "gpt-6.1-sol", "responses")
const mai = makeModel("mai-code-1.1-flash", "MAI Code 1.1 Flash", "mai-code", "responses")
const gemini = makeModel("gemini-3.1-pro", "Gemini 3.1 Pro", "gemini-3.1-pro", "chat")

const catalog = [sonnet, haiku, gpt54, luna, sol]

type Handler = (body: Record<string, unknown>) => unknown
type Call = { kind?: "auto" | "legacy"; body: Record<string, unknown>; headers: Record<string, string> }

// Replaces fetch for the duration of `fn`. A handler returning a number answers
// with that HTTP status; anything else is sent as a 200 JSON body.
async function withFetch<T>(handlers: { auto?: Handler; legacy?: Handler }, fn: (calls: Call[]) => Promise<T>) {
  const origFetch = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString()
    const kind = u.endsWith("/auto") ? "auto" : u.endsWith("/models/session") ? "legacy" : undefined
    const body = init?.body ? JSON.parse(init.body as string) : {}
    calls.push({ kind, body, headers: (init?.headers ?? {}) as Record<string, string> })
    const handler = kind && handlers[kind]
    if (!handler) return new Response("not found", { status: 404 })
    const reply = handler(body)
    if (typeof reply === "number") return new Response("error", { status: reply })
    return Response.json(reply)
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = origFetch
  }
}

const autoPicks = (id: string, ttlSeconds = 86_400) => () => ({
  session_token: `tok-${id}`,
  expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
  selected_model: { id },
})

const oauth = { type: "oauth", refresh: "test-bearer", access: "", expires: 0, metadata: {} }

type Hook = (event: any) => Promise<void> | void

// Loads the plugin against a minimal stand-in for opencode 2's plugin context: a
// model editor over `models` and a recorder for session hooks.
async function setup(models: FakeModel[], options: Record<string, unknown> = {}, credential: unknown = oauth) {
  const store = new Map(models.map((m) => [m.id, structuredClone(m)]))
  const hooks = new Map<string, { callback: Hook; providerID?: string }>()
  const transforms: Array<(editor: unknown) => void> = []
  const registration = { dispose: async () => {} }
  const ctx = {
    options,
    integration: {
      connection: {
        active: async () => (credential ? { integrationID: "github-copilot" } : undefined),
        resolve: async () => credential,
      },
    },
    model: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push(callback)
        runTransforms()
        return registration
      },
    },
    session: {
      hook: async (name: string, callback: Hook, opts?: { providerID?: string }) => {
        hooks.set(name, { callback, providerID: opts?.providerID })
        return registration
      },
    },
  }
  // opencode replays transforms over the source catalog whenever it changes.
  function runTransforms() {
    const data = new Map(models.map((m) => [m.id, structuredClone(m)]))
    const editor = {
      list: () => Array.from(data.values()),
      get: (_p: string, id: string) => data.get(id),
      update: (_p: string, id: string, fn: (draft: Record<string, unknown>) => void) => {
        const draft = (data.get(id) ?? {}) as Record<string, unknown>
        fn(draft)
        draft.id = id
        draft.providerID = "github-copilot"
        data.set(id, draft as FakeModel)
      },
      remove: (_p: string, id: string) => data.delete(id),
    }
    for (const transform of transforms) transform(editor)
    store.clear()
    for (const [id, model] of data) store.set(id, model)
  }
  await plugin.setup(ctx as never)

  const call = async (name: string, event: Record<string, unknown>) => hooks.get(name)?.callback(event)

  // One model call as opencode 2 issues it: prompt admission (when `prompt` is set),
  // context, model.request, then the native HTTP request built for the model's modelID.
  async function turn(
    modelKey: string,
    { sessionID = "ses_test", prompt = "test prompt" as string | null, files = [] as unknown[], kind = "primary" } = {},
  ) {
    const model = store.get(modelKey)!
    const ref = { providerID: "github-copilot", id: modelKey }
    if (prompt !== null) await call("prompt", { sessionID, prompt: { text: prompt, files } })
    const context = { sessionID, agent: "build", model: ref, system: [], messages: [], tools: {}, options: {} as Record<string, unknown> }
    if (kind === "primary") await call("context", context)
    if (kind === "compaction") await call("compaction", context)
    const modelRequest = { sessionID, agent: "build", model: ref, kind, headers: {} as Record<string, string> }
    await call("model.request", modelRequest)
    const request = new Request(`${COPILOT}/responses`, {
      method: "POST",
      headers: { ...modelRequest.headers, "content-type": "application/json", "content-length": "999" },
      body: JSON.stringify({ model: model.modelID, input: [], temperature: 0.7 }),
    })
    const http = { sessionID, agent: "build", model: ref, kind, request }
    await call("http.request", http)
    const sent = JSON.parse(await http.request.text()) as { model: string; temperature?: number }
    return {
      model: sent.model,
      temperature: sent.temperature,
      token: modelRequest.headers["Copilot-Session-Token"],
      options: context.options,
      contentLength: http.request.headers.get("content-length"),
    }
  }

  return { store, hooks, turn, call, runTransforms }
}

describe("catalog injection", () => {
  test("injects Auto cloned from a GPT Responses anchor", async () => {
    const { store } = await setup(catalog)
    const auto = store.get("auto")!
    expect(auto.name).toBe("Auto")
    expect(auto.modelID).toBe("gpt-5.4")
    expect(auto.package).toBe(COPILOT_SDK)
    expect(auto.settings.endpoint).toBe("responses")
    expect(auto.family).toBe("gpt-5.4")
    expect(auto.variants).toEqual([])
  })

  test("makes no network calls while building the catalog", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      await setup(catalog)
      expect(calls).toHaveLength(0)
    })
  })

  test("an auto anchored on Claude keeps the anchor's endpoint", async () => {
    const { store } = await setup(catalog, { preferredModels: ["claude-sonnet-5.5"] })
    expect(store.get("auto")!.settings.baseURL).toBe(`${COPILOT}/v1`)
    expect(store.get("auto")!.package).toBe(ANTHROPIC)
  })
  test("replaying the transform never anchors an auto on another auto", async () => {
    const { store, runTransforms } = await setup(catalog)
    runTransforms()
    runTransforms()
    expect(store.get("auto")!.modelID).toBe("gpt-5.4")
    expect(store.get("auto-2")).toBeUndefined()
  })

  test("anchors on a GPT Responses model even when Chat-only models come first", async () => {
    const kimi = makeModel("kimi-k3", "Kimi K3", "kimi", "chat")
    const mini = makeModel("gpt-5-mini", "GPT-5 mini", "gpt-5-mini", "chat")
    const { store } = await setup([kimi, mini, ...catalog])
    expect(store.get("auto")!.modelID).toBe("gpt-5.4")
    expect(store.get("auto-intelligence")!.modelID).toBe("gpt-5.4")
  })

  test("preferredModels anchors every default auto by model key, in order", async () => {
    const { store } = await setup(catalog, { preferredModels: ["nope", "gpt-6-luna"] })
    expect(store.get("auto")!.modelID).toBe("gpt-6-luna")
    expect(store.get("auto-efficiency")!.modelID).toBe("gpt-6-luna")
    expect(store.get("auto-intelligence")!.modelID).toBe("gpt-6-luna")
  })

  test("injects one auto per picker tier, like VS Code's Auto picker", async () => {
    const { store } = await setup(catalog)
    const autos = [...store.values()].filter((m) => m.id.startsWith("auto")).map((m) => [m.id, m.name])
    expect(autos).toEqual([
      ["auto", "Auto"],
      ["auto-efficiency", "Auto Efficiency"],
      ["auto-intelligence", "Auto Intelligence"],
    ])
  })

  test("the tier option sets the main auto and the variants cover the other picker tiers", async () => {
    const { store } = await setup(catalog, { tier: "intelligence" })
    expect(store.get("auto-balance")!.name).toBe("Auto Balance")
    expect(store.get("auto-efficiency")).toBeDefined()
    expect(store.get("auto-intelligence")).toBeUndefined()
  })

  test("fast is not a picker tier: it falls back to balance, as in Copilot CLI", async () => {
    const { store } = await setup(catalog, { tier: "fast" })
    expect(store.get("auto-fast")).toBeUndefined()
    expect(store.get("auto-balance")).toBeUndefined()
    expect(store.get("auto-intelligence")).toBeDefined()
  })
  test("scopes request hooks to the Copilot provider", async () => {
    const { hooks } = await setup(catalog)
    for (const name of ["compaction", "model.request", "http.request"])
      expect(hooks.get(name)?.providerID).toBe("github-copilot")
  })
})

describe("routing via POST /auto", () => {
  test("without a Copilot OAuth connection uses the anchor and sends no token", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog, {}, null)
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
      expect(calls).toHaveLength(0)
    })
  })

  test("sends prompt and default tier, then routes the request to the selected model", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog)
      const result = await turn("auto", { prompt: "rename this variable" })
      expect(calls).toHaveLength(1)
      expect(calls[0].body).toEqual({ prompt: "rename this variable", tier: "balance" })
      expect(calls[0].headers["X-GitHub-Api-Version"]).toBe("2026-08-01")
      expect(calls[0].headers.Authorization).toBe("Bearer test-bearer")
      expect(result.model).toBe("gpt-6-luna")
      expect(result.token).toBe("tok-gpt-6-luna")
      expect(result.contentLength).toBeNull()
      expect(result.temperature).toBeUndefined()
      expect(result.options).toEqual({})
    })
  })

  test("uses the enterprise endpoint from the credential", async () => {
    const urls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(url.toString())
      return Response.json(autoPicks("gpt-6-luna")())
    }) as typeof fetch
    try {
      const { turn } = await setup(catalog, {}, { ...oauth, metadata: { enterpriseUrl: "https://acme.ghe.com/" } })
      await turn("auto")
      expect(urls).toEqual(["https://copilot-api.acme.ghe.com/auto"])
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test("sends the configured tier (retired names mapped forward), and the tier only steers the router", async () => {
    await withFetch({ auto: autoPicks("gpt-6.1-sol") }, async (calls) => {
      const { turn } = await setup(catalog, { tier: "max" })
      const result = await turn("auto")
      expect(calls[0].body.tier).toBe("intelligence")
      expect(result.options).toEqual({})
    })
  })
  test("flags image attachments with has_image", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto", { files: [{ uri: "file:///tmp/screenshot.png" }] })
      expect(calls[0].body.has_image).toBe(true)
    })
  })

  test("sticks with the first route for the rest of the conversation", async () => {
    let pick = "gpt-6-luna"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      pick = "gpt-6.1-sol"
      const second = await turn("auto", { prompt: "follow-up" })
      const toolStep = await turn("auto", { prompt: null })
      expect(calls).toHaveLength(1)
      expect(second.model).toBe("gpt-6-luna")
      expect(toolStep.token).toBe("tok-gpt-6-luna")
    })
  })

  test("re-routes on the next agent turn after compaction, not for the compaction itself", async () => {
    let pick = "gpt-6-luna"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      pick = "gpt-6.1-sol"
      const compaction = await turn("auto", { prompt: null, kind: "compaction" })
      expect(compaction.model).toBe("gpt-6-luna")
      const after = await turn("auto")
      expect(calls).toHaveLength(2)
      expect(after.model).toBe("gpt-6.1-sol")
    })
  })

  test("re-routes when the session token is about to expire", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna", 60) }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      await turn("auto")
      expect(calls).toHaveLength(2)
    })
  })

  test("routes each auto separately within one session, with its own tier", async () => {
    await withFetch({ auto: (body) => autoPicks(body.tier === "intelligence" ? "gpt-6.1-sol" : "gpt-6-luna")() }, async (calls) => {
      const { turn } = await setup(catalog)
      const balance = await turn("auto")
      await turn("auto")
      const intelligence = await turn("auto-intelligence")
      expect(calls.map((c) => c.body.tier)).toEqual(["balance", "intelligence"])
      expect(balance.model).toBe("gpt-6-luna")
      expect(intelligence.model).toBe("gpt-6.1-sol")
      expect(intelligence.token).toBe("tok-gpt-6.1-sol")
    })
  })

  test("a pick on another endpoint falls back to the anchor without a token and stays sticky", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog, { preferredModels: ["claude-sonnet-5.5"] })
      const first = await turn("auto")
      const second = await turn("auto")
      expect(first.model).toBe("claude-sonnet-5.5")
      expect(first.token).toBeUndefined()
      expect(second.model).toBe("claude-sonnet-5.5")
      expect(calls).toHaveLength(1)
    })
  })

  test("judges the pick against a catalog swapped in while routing", async () => {
    // opencode first builds the catalog without an account endpoint, then replays
    // the transform with the live one (e.g. a business endpoint) during the request.
    const BUSINESS = "https://api.business.githubcopilot.com"
    const models: FakeModel[] = catalog.map((m) => ({ ...structuredClone(m), settings: { endpoint: m.settings.endpoint } }))
    const live = () => {
      models.splice(0, models.length, ...catalog.map((m) => ({ ...structuredClone(m), settings: { ...m.settings, baseURL: BUSINESS } })))
      runTransforms()
      return autoPicks("gpt-6-luna")()
    }
    let runTransforms = () => {}
    await withFetch({ auto: live }, async () => {
      const harness = await setup(models)
      runTransforms = harness.runTransforms
      const result = await harness.turn("auto")
      expect(result.model).toBe("gpt-6-luna")
      expect(result.token).toBe("tok-gpt-6-luna")
    })
  })

  test("a pick on another wire API falls back to the anchor", async () => {
    await withFetch({ auto: autoPicks("gemini-3.1-pro") }, async () => {
      const { turn } = await setup([...catalog, gemini])
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("accepts another family on the same endpoint and wire API", async () => {
    await withFetch({ auto: autoPicks("mai-code-1.1-flash") }, async () => {
      const { turn } = await setup([...catalog, mai])
      const result = await turn("auto")
      expect(result.model).toBe("mai-code-1.1-flash")
      expect(result.token).toBe("tok-mai-code-1.1-flash")
    })
  })

  test("a pick missing from the catalog falls back to the anchor", async () => {
    await withFetch({ auto: autoPicks("gpt-9") }, async () => {
      const { turn } = await setup(catalog)
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("leaves non-auto models alone", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog)
      const result = await turn("gpt-5.4")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
      expect(result.contentLength).toBe("999")
      expect(result.temperature).toBe(0.7)
      expect(calls).toHaveLength(0)
    })
  })
})

describe("when routing fails or cannot serve the turn", () => {
  test("falls back to the anchor without a token, and retries on the next prompt, not every step", async () => {
    await withFetch({ auto: () => 503 }, async (calls) => {
      const { turn } = await setup(catalog)
      const first = await turn("auto")
      const toolStep = await turn("auto", { prompt: null })
      expect(first.model).toBe("gpt-5.4")
      expect(first.token).toBeUndefined()
      expect(toolStep.model).toBe("gpt-5.4")
      expect(calls).toHaveLength(1)
      await turn("auto", { prompt: "next prompt" })
      expect(calls).toHaveLength(2)
      expect(calls.every((c) => c.kind === "auto")).toBe(true)
    })
  })

  test("keeps the last route when re-routing after compaction fails", async () => {
    let fail = false
    await withFetch({ auto: () => (fail ? 503 : autoPicks("gpt-6-luna")()) }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      await turn("auto", { prompt: null, kind: "compaction" })
      fail = true
      const after = await turn("auto", { prompt: "after compaction" })
      expect(calls).toHaveLength(2)
      expect(after.model).toBe("gpt-6-luna")
      expect(after.token).toBe("tok-gpt-6-luna")
      fail = false
      await turn("auto", { prompt: "later" })
      expect(calls).toHaveLength(3)
    })
  })

  test("routes again when an image turn meets a model without vision", async () => {
    const textOnly = { ...structuredClone(luna), capabilities: { input: ["text"] } } as FakeModel
    let pick = "gpt-6-luna"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { turn } = await setup([sonnet, haiku, gpt54, textOnly, sol])
      expect((await turn("auto")).model).toBe("gpt-6-luna")
      pick = "gpt-6.1-sol"
      const image = await turn("auto", { prompt: "what is in this screenshot?", files: [{ uri: "file:///tmp/shot.png" }] })
      expect(calls).toHaveLength(2)
      expect(calls[1].body.has_image).toBe(true)
      expect(image.model).toBe("gpt-6.1-sol")
    })
  })
})

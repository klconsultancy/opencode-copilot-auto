// opencode 1 adapter (`server`), against opencode 1's provider and chat hooks.
import { describe, expect, test } from "bun:test"
import plugin from "../src/index"

const makeModel = (id: string, apiId: string, npm: string, url: string, name: string, reasoning = false, temperature = true) => ({
  id,
  providerID: "github-copilot",
  api: { id: apiId, url, npm },
  name,
  family: "gpt",
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 8192 },
  capabilities: {
    temperature,
    reasoning,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "2026-01-01",
})

const COPILOT = "https://api.githubcopilot.com"

const sonnet = makeModel("claude-sonnet-4.6", "claude-sonnet-4.6", "@ai-sdk/anthropic", `${COPILOT}/v1`, "Claude Sonnet 4.6", true)
const haiku = makeModel("claude-haiku-4.5", "claude-haiku-4.5", "@ai-sdk/anthropic", `${COPILOT}/v1`, "Claude Haiku 4.5")
const gpt54 = makeModel("gpt-5.4", "gpt-5.4", "@ai-sdk/github-copilot", COPILOT, "GPT-5.4", true)
const gpt54mini = makeModel("gpt-5.4-mini", "gpt-5.4-mini", "@ai-sdk/github-copilot", COPILOT, "GPT-5.4 mini")
const gemini = makeModel("gemini-3.1-pro", "gemini-3.1-pro", "@ai-sdk/github-copilot", COPILOT, "Gemini 3.1 Pro")

const catalog = { [sonnet.id]: sonnet, [haiku.id]: haiku, [gpt54.id]: gpt54, [gpt54mini.id]: gpt54mini }

const oauth = {
  auth: { type: "oauth", refresh: "test-bearer", access: "test-access", expires: Date.now() + 3600_000 } as never,
}

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

async function setup(models: Record<string, unknown>, options: Record<string, unknown> = {}, ctx: object = oauth) {
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} } } } as never, options)
  const resolved = (await hooks.provider!.models!({ id: "github-copilot", models } as never, ctx as never)) as Record<string, any>
  // One model call; `prompt: null` is a follow-up step of the same turn (no new user message).
  async function turn(autoID: string, { sessionID = "ses_test", prompt = "test prompt" as string | null, parts = [] as unknown[] } = {}) {
    if (prompt !== null)
      await hooks["chat.message"]!({ sessionID } as never, { parts: [{ type: "text", text: prompt }, ...parts] } as never)
    const input = {
      sessionID,
      agent: "build",
      model: resolved[autoID],
      provider: { source: "config", info: {} as never, options: {} },
      message: {} as never,
    }
    const output = {
      temperature: 0.7 as number | undefined,
      topP: 0,
      topK: 0,
      maxOutputTokens: undefined as number | undefined,
      options: {} as Record<string, unknown>,
    }
    await hooks["chat.params"]!(input as never, output as never)
    const headers = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!(input as never, headers as never)
    return {
      model: headers.headers["x-copilot-auto-route"],
      options: output.options,
      temperature: output.temperature,
      token: headers.headers["Copilot-Session-Token"],
    }
  }
  return { hooks, resolved, turn }
}

describe("catalog injection", () => {
  test("anchors Auto on the shared Copilot transport", async () => {
    const { resolved } = await setup(catalog)
    expect(resolved.auto.name).toBe("Auto")
    expect(resolved.auto.api.npm).toBe("@ai-sdk/github-copilot")
    expect(resolved.auto.family).toBe("github-copilot-auto")
  })

  test("anchors Auto on an @ai-sdk/openai GPT model rather than Claude", async () => {
    const openaiGpt = { ...gpt54, api: { ...gpt54.api, npm: "@ai-sdk/openai" } }
    const { resolved } = await setup({ [sonnet.id]: sonnet, [haiku.id]: haiku, [openaiGpt.id]: openaiGpt })
    expect(resolved.auto.api.id).toBe("gpt-5.4")
  })

  test("anchors on a GPT Responses model even when a Chat-only Copilot model comes first", async () => {
    const kimi = makeModel("kimi-k3", "kimi-k3", "@ai-sdk/github-copilot", COPILOT, "Kimi K3")
    const luna = makeModel("gpt-6-luna", "gpt-6-luna", "@ai-sdk/github-copilot", COPILOT, "GPT-6 Luna")
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async () => {
      const { resolved, turn } = await setup({ [kimi.id]: kimi, ...catalog, [luna.id]: luna })
      expect(resolved.auto.api.id).toBe("gpt-5.4")
      expect(resolved["auto-intelligence"].api.id).toBe("gpt-5.4")
      expect((await turn("auto")).model).toBe("gpt-6-luna")
      expect((await turn("auto-intelligence", { sessionID: "ses_int" })).model).toBe("gpt-6-luna")
    })
  })

  test("routes to a new model the legacy pool never offered", async () => {
    const luna = makeModel("gpt-6-luna", "gpt-6-luna", "@ai-sdk/github-copilot", COPILOT, "GPT-6 Luna")
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async () => {
      const { turn } = await setup({ ...catalog, [luna.id]: luna })
      const result = await turn("auto")
      expect(result.model).toBe("gpt-6-luna")
      expect(result.token).toBe("tok-gpt-6-luna")
    })
  })

  test("drops temperature when the routed model does not support it", async () => {
    const luna = makeModel("gpt-6-luna", "gpt-6-luna", "@ai-sdk/github-copilot", COPILOT, "GPT-6 Luna", true, false)
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async () => {
      const { turn } = await setup({ ...catalog, [luna.id]: luna })
      expect((await turn("auto")).temperature).toBeUndefined()
    })
    await withFetch({ auto: autoPicks("gpt-5.4-mini") }, async () => {
      const { turn } = await setup(catalog)
      expect((await turn("auto")).temperature).toBe(0.7)
    })
  })

  test("makes no network calls while building the catalog", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      await setup(catalog)
      expect(calls).toHaveLength(0)
    })
  })

  test("preserves /v1 in url for a Claude-anchored auto (Anthropic SDK appends /messages)", async () => {
    const { resolved } = await setup(catalog, { preferredModels: ["claude-sonnet-4.6"] })
    expect(resolved.auto.api.url).toBe(`${COPILOT}/v1`)
    expect(resolved.auto.api.npm).toBe("@ai-sdk/anthropic")
  })
  test("no-ops when auto already present", async () => {
    const existing = { ...gpt54, id: "auto" }
    const { resolved } = await setup({ ...catalog, auto: existing })
    expect(resolved.auto as unknown).toBe(existing)
  })

  test("preferredModels anchors by model key or api id, in order", async () => {
    const byKey = await setup(catalog, { preferredModels: ["claude-haiku-4.5", "gpt-5.4"] })
    expect(byKey.resolved.auto.api.id).toBe("claude-haiku-4.5")
    const skipsUnknown = await setup(catalog, { preferredModels: ["nope", "gpt-5.4-mini"] })
    expect(skipsUnknown.resolved.auto.api.id).toBe("gpt-5.4-mini")
  })

  test("injects one auto per picker tier, like VS Code's Auto picker", async () => {
    const { resolved } = await setup(catalog)
    expect(resolved.auto.name).toBe("Auto")
    expect(resolved["auto-efficiency"].name).toBe("Auto Efficiency")
    expect(resolved["auto-intelligence"].name).toBe("Auto Intelligence")
    expect(resolved["auto-balance"]).toBeUndefined()
  })

  test("preferredModels anchors the tier variants too", async () => {
    const { resolved } = await setup(catalog, { preferredModels: ["gpt-5.4-mini"] })
    expect(resolved["auto-efficiency"].api.id).toBe("gpt-5.4-mini")
  })

  test("fast is not a picker tier: it falls back to balance, as in Copilot CLI", async () => {
    const { resolved } = await setup(catalog, { tier: "fast" })
    expect(resolved["auto-fast"]).toBeUndefined()
    expect(resolved["auto-intelligence"]).toBeDefined()
  })
})

describe("routing via POST /auto", () => {
  test("without Copilot OAuth falls back to the catalog anchor and sends no token", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog, {}, {})
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
      expect(calls).toHaveLength(0)
    })
  })

  test("sends the prompt and default tier, then uses the selected model and token", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4-mini") }, async (calls) => {
      const { turn } = await setup(catalog)
      const result = await turn("auto", { prompt: "rename this variable" })
      expect(calls).toHaveLength(1)
      expect(calls[0].body).toEqual({ prompt: "rename this variable", tier: "balance" })
      expect(calls[0].headers["X-GitHub-Api-Version"]).toBe("2026-08-01")
      expect(calls[0].headers.Authorization).toBe("Bearer test-bearer")
      expect(result.model).toBe("gpt-5.4-mini")
      expect(result.token).toBe("tok-gpt-5.4-mini")
      expect(result.options.reasoningEffort).toBeUndefined()
    })
  })

  test("sends the configured tier (retired names mapped forward), and the tier only steers the router", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog, { tier: "max" })
      const result = await turn("auto")
      expect(calls[0].body.tier).toBe("intelligence")
      expect(result.options).toEqual({})
    })
  })
  test("unknown tier falls back to balance", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog, { tier: "turbo" })
      await turn("auto")
      expect(calls[0].body.tier).toBe("balance")
    })
  })

  test("sends only what the user typed, not opencode's synthetic parts", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto", { prompt: "fix the bug", parts: [{ type: "text", text: "<file contents>", synthetic: true }] })
      expect(calls[0].body.prompt).toBe("fix the bug")
    })
  })

  test("flags image attachments with has_image", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto", { parts: [{ type: "file", mime: "image/png", url: "data:," }] })
      expect(calls[0].body.has_image).toBe(true)
    })
  })

  test("sticks with the first route for the rest of the conversation", async () => {
    let pick = "gpt-5.4"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { turn } = await setup(catalog)
      const first = await turn("auto")
      pick = "gpt-5.4-mini"
      const second = await turn("auto", { prompt: "follow-up" })
      expect(calls).toHaveLength(1)
      expect(second.model).toBe(first.model)
      expect(second.token).toBe("tok-gpt-5.4")
    })
  })

  test("re-routes after compaction", async () => {
    let pick = "gpt-5.4"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { hooks, turn } = await setup(catalog)
      await turn("auto")
      await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "ses_test" } } } as never)
      pick = "gpt-5.4-mini"
      const after = await turn("auto")
      expect(calls).toHaveLength(2)
      expect(after.model).toBe("gpt-5.4-mini")
    })
  })

  test("re-routes when the session token is about to expire", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4", 60) }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      await turn("auto")
      expect(calls).toHaveLength(2)
    })
  })

  test("routes each auto separately within one session, with its own tier", async () => {
    await withFetch({ auto: (body) => autoPicks(body.tier === "intelligence" ? "gpt-5.4" : "gpt-5.4-mini")() }, async (calls) => {
      const { turn } = await setup(catalog)
      const balance = await turn("auto")
      await turn("auto")
      const intelligence = await turn("auto-intelligence")
      expect(calls.map((c) => c.body.tier)).toEqual(["balance", "intelligence"])
      expect(balance.model).toBe("gpt-5.4-mini")
      expect(intelligence.model).toBe("gpt-5.4")
      expect(intelligence.options).toEqual({})
    })
  })

  test("cross-endpoint pick falls back to the anchor without a token and stays sticky", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog, { preferredModels: ["claude-sonnet-4.6"] })
      const first = await turn("auto")
      const second = await turn("auto")
      expect(first.model).toBe("claude-sonnet-4.6")
      expect(first.token).toBeUndefined()
      expect(second.model).toBe("claude-sonnet-4.6")
      expect(calls).toHaveLength(1)
    })
  })

  test("accepts another family on the same transport and wire API", async () => {
    const mai = makeModel("mai-code-1.1-flash", "mai-code-1.1-flash", "@ai-sdk/github-copilot", COPILOT, "MAI Code 1.1 Flash")
    await withFetch({ auto: autoPicks("mai-code-1.1-flash") }, async () => {
      const { turn } = await setup({ ...catalog, [gemini.id]: gemini, [mai.id]: mai }, { preferredModels: ["gemini-3.1-pro"] })
      const result = await turn("auto")
      expect(result.model).toBe("mai-code-1.1-flash")
      expect(result.token).toBe("tok-mai-code-1.1-flash")
    })
  })

  test("a pick on another wire API (chat vs responses) falls back to the anchor", async () => {
    const mai = makeModel("mai-code-1.1-flash", "mai-code-1.1-flash", "@ai-sdk/github-copilot", COPILOT, "MAI Code 1.1 Flash")
    await withFetch({ auto: autoPicks("mai-code-1.1-flash") }, async () => {
      const { turn } = await setup({ ...catalog, [mai.id]: mai })
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("a pick missing from the opencode catalog falls back to the anchor", async () => {
    await withFetch({ auto: autoPicks("gpt-9") }, async () => {
      const { turn } = await setup(catalog)
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("leaves models of other providers alone", async () => {
    const { hooks } = await setup(catalog)
    const output = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]!({ sessionID: "s", model: { providerID: "anthropic", id: "auto" } } as never, output as never)
    expect(output.options.model).toBeUndefined()
  })
})

describe("request rewrite", () => {
  test("swaps the routed model into the body and strips the private header", async () => {
    await withFetch({}, async (calls) => {
      await setup(catalog)
      await fetch(`${COPILOT}/responses`, {
        method: "POST",
        headers: { "X-Copilot-Auto-Route": "gpt-6-luna", "Copilot-Session-Token": "tok" },
        body: JSON.stringify({ model: "gpt-5.4", input: [] }),
      })
      expect(calls[0].body).toEqual({ model: "gpt-6-luna", input: [] })
      const sent = new Headers(calls[0].headers)
      expect(sent.has("x-copilot-auto-route")).toBe(false)
      expect(sent.get("copilot-session-token")).toBe("tok")
    })
  })

  test("leaves requests without the route header untouched", async () => {
    await withFetch({}, async (calls) => {
      await setup(catalog)
      const init = { method: "POST", headers: { Authorization: "x" }, body: JSON.stringify({ model: "gpt-5.4" }) }
      await fetch(`${COPILOT}/responses`, init)
      expect(calls[0].body).toEqual({ model: "gpt-5.4" })
      expect(calls[0].headers).toBe(init.headers)
    })
  })

  test("wraps fetch only once across plugin instances", async () => {
    await withFetch({}, async (calls) => {
      await setup(catalog)
      await setup(catalog)
      await fetch(`${COPILOT}/responses`, {
        method: "POST",
        headers: { "x-copilot-auto-route": "gpt-6-luna" },
        body: JSON.stringify({ model: "gpt-5.4" }),
      })
      expect(calls).toHaveLength(1)
      expect(calls[0].body.model).toBe("gpt-6-luna")
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
    await withFetch({ auto: () => (fail ? 503 : autoPicks("gpt-5.4-mini")()) }, async (calls) => {
      const { hooks, turn } = await setup(catalog)
      await turn("auto")
      await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "ses_test" } } } as never)
      fail = true
      const after = await turn("auto", { prompt: "after compaction" })
      expect(calls).toHaveLength(2)
      expect(after.model).toBe("gpt-5.4-mini")
      expect(after.token).toBe("tok-gpt-5.4-mini")
      fail = false
      await turn("auto", { prompt: "later" })
      expect(calls).toHaveLength(3)
    })
  })

  test("routes again when an image turn meets a model without vision", async () => {
    const textOnly = makeModel("gpt-5.4-mini", "gpt-5.4-mini", "@ai-sdk/github-copilot", COPILOT, "GPT-5.4 mini")
    textOnly.capabilities.input.image = false
    const vision = { ...gpt54, capabilities: { ...gpt54.capabilities, input: { ...gpt54.capabilities.input, image: true } } }
    let pick = "gpt-5.4-mini"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { turn } = await setup({ [sonnet.id]: sonnet, [vision.id]: vision, [textOnly.id]: textOnly })
      expect((await turn("auto")).model).toBe("gpt-5.4-mini")
      pick = "gpt-5.4"
      const image = await turn("auto", { prompt: "what is in this screenshot?", parts: [{ type: "file", mime: "image/png", url: "data:," }] })
      expect(calls).toHaveLength(2)
      expect(calls[1].body.has_image).toBe(true)
      expect(image.model).toBe("gpt-5.4")
    })
  })
})

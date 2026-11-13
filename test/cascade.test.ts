// Experimental cascade (opencode 2): the pure parts, then the flow through the
// plugin's hooks against a minimal stand-in for opencode 2's plugin context.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { CASCADE_ID, Cascade, cascadeLogFile, cascadeSpec, parseVerdict, pickJudge } from "../src/cascade"
import type { CatalogModel } from "../src/core"
import plugin from "../src/index"
import { freshStateDir } from "./setup"

const COPILOT = "https://api.githubcopilot.com"

const model = (apiID: string, name: string, wire: CatalogModel["wire"] = "responses", enabled = true): CatalogModel => ({
  key: apiID,
  apiID,
  name,
  transport: `sdk ${COPILOT}`,
  wire,
  enabled,
  vision: true,
})

const gpt54 = model("gpt-5.4", "GPT-5.4")
const luna = model("gpt-6-luna", "GPT-6 Luna")
const sonnet = model("claude-sonnet-5.5", "Claude Sonnet 5.5", "messages")
const haiku = model("claude-haiku-5.5", "Claude Haiku 5.5", "messages")
const gemini = model("gemini-3.1-pro", "Gemini 3.1 Pro", "chat")

describe("cascadeSpec", () => {
  test("drafts through /auto on the efficiency tier by default", () => {
    const spec = cascadeSpec(luna, [luna, gpt54], undefined)
    expect(spec).toMatchObject({ id: CASCADE_ID, tier: "efficiency", anchor: luna })
    expect(spec.pinned).toBeUndefined()
  })

  test("pins the draft to an enabled model", () => {
    const spec = cascadeSpec(luna, [luna, gpt54], "gpt-5.4")
    expect(spec.anchor.apiID).toBe("gpt-5.4")
    expect(spec.pinned).toBe(true)
  })

  test("ignores a draft model that is not enabled", () => {
    const off = model("gpt-4o-mini", "GPT-4o mini", "chat", false)
    expect(cascadeSpec(luna, [luna, off], "gpt-4o-mini").pinned).toBeUndefined()
  })
})

describe("pickJudge", () => {
  test("prefers a lightweight model from another family than the draft", () => {
    expect(pickJudge([gpt54, luna, sonnet, haiku], "gpt-6-luna")?.apiID).toBe("claude-haiku-5.5")
  })

  test("gemini is not a lightweight name", () => {
    const argon = model("gemini-4-argon", "Gemini 4 Argon", "chat")
    expect(pickJudge([luna, argon, sonnet, haiku], "gpt-6-luna")?.apiID).toBe("claude-haiku-5.5")
  })

  test("takes any other family when none is lightweight", () => {
    expect(pickJudge([gpt54, luna, sonnet], "gpt-6-luna")?.apiID).toBe("claude-sonnet-5.5")
  })

  test("falls back to another model of the same family", () => {
    expect(pickJudge([gpt54, luna], "gpt-6-luna")?.apiID).toBe("gpt-5.4")
  })

  test("honors a configured judge by key or API id, if enabled", () => {
    expect(pickJudge([gpt54, luna, haiku, gemini], "gpt-6-luna", "gemini-3.1-pro")?.apiID).toBe("gemini-3.1-pro")
    const off = model("gemini-3.1-pro", "Gemini 3.1 Pro", "chat", false)
    expect(pickJudge([gpt54, luna, haiku, off], "gpt-6-luna", "gemini-3.1-pro")?.apiID).toBe("claude-haiku-5.5")
  })

  test("skips disabled models", () => {
    const off = model("claude-haiku-5.5", "Claude Haiku 5.5", "messages", false)
    expect(pickJudge([luna, off, sonnet], "gpt-6-luna")?.apiID).toBe("claude-sonnet-5.5")
  })
})

describe("parseVerdict", () => {
  test("reads the JSON object, also inside a code fence", () => {
    const text = 'Here:\n```json\n{"verdict":"Escalate","confidence":0.8,"reasons":["tests not run"]}\n```'
    expect(parseVerdict(text)).toEqual({ verdict: "escalate", confidence: 0.8, reasons: ["tests not run"] })
  })

  test("anything else is unparsed and keeps the text as the reason", () => {
    expect(parseVerdict("looks fine to me")).toEqual({ verdict: "unparsed", reasons: ["looks fine to me"] })
    expect(parseVerdict('{"verdict":"maybe"}').verdict).toBe("unparsed")
    expect(parseVerdict("").reasons).toEqual([])
  })
})

function records() {
  const file = cascadeLogFile()
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

describe("Cascade turn tracking", () => {
  function make(generate = async () => ({ text: '{"verdict":"accept","confidence":0.9,"reasons":[]}', cost: 0.01 })) {
    freshStateDir()
    const calls: string[] = []
    const cascade = new Cascade({
      options: {},
      catalog: () => [gpt54, luna, haiku],
      generate: async (sessionID) => {
        calls.push(sessionID)
        return generate()
      },
      parentOf: async (sessionID) => (sessionID.startsWith("child") ? "ses_parent" : undefined),
    })
    return { cascade, calls }
  }

  test("ignores sessions that are not on the cascade auto", async () => {
    const { cascade, calls } = make()
    cascade.onPrompt("ses_1", "msg_1", "fix it")
    cascade.onPrimaryRequest("ses_1", "auto", "gpt-6-luna")
    cascade.onPrimaryRequest("ses_1", "auto", "gpt-6-luna")
    cascade.onIdle("ses_1", [])
    await cascade.pending
    expect(calls).toEqual([])
    expect(records()).toEqual([])
  })

  test("waits for background work, then judges a turn once", async () => {
    const { cascade, calls } = make()
    cascade.onPrompt("ses_1", "msg_1", "fix it")
    cascade.onPrimaryRequest("ses_1", CASCADE_ID, "gpt-6-luna")
    cascade.onPrimaryRequest("ses_1", CASCADE_ID, "gpt-6-luna")
    cascade.onIdle("ses_1", [{ kind: "shell" }])
    await cascade.pending
    expect(calls).toEqual([])
    cascade.onIdle("ses_1", [])
    cascade.onIdle("ses_1", [])
    await cascade.pending
    expect(calls).toEqual(["ses_1"])
    const [entry] = records()
    expect(entry).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_1",
      verdict: "accept",
      confidence: 0.9,
      judgeModel: "claude-haiku-5.5",
      draftModels: ["gpt-6-luna"],
      requests: 2,
      cost: 0.01,
    })
  })

  test("records a single-request turn as skipped, without a judge call", async () => {
    const { cascade, calls } = make()
    cascade.onPrompt("ses_1", "msg_1", "what does this do?")
    cascade.onPrimaryRequest("ses_1", CASCADE_ID, "gpt-6-luna")
    cascade.onIdle("ses_1", [])
    await cascade.pending
    expect(calls).toEqual([])
    expect(records()).toMatchObject([{ verdict: "skipped", reasons: ["single request"] }])
  })

  test("does not judge subagent sessions", async () => {
    const { cascade, calls } = make()
    cascade.onPrompt("child_1", "msg_1", "search")
    cascade.onPrimaryRequest("child_1", CASCADE_ID, "gpt-6-luna")
    cascade.onPrimaryRequest("child_1", CASCADE_ID, "gpt-6-luna")
    cascade.onIdle("child_1", [])
    await cascade.pending
    expect(calls).toEqual([])
    expect(records()).toEqual([])
  })

  test("a failing judge request is recorded as an error", async () => {
    const { cascade } = make(async () => {
      throw new Error("boom")
    })
    cascade.onPrompt("ses_1", "msg_1", "fix it")
    cascade.onPrimaryRequest("ses_1", CASCADE_ID, "gpt-6-luna")
    cascade.onPrimaryRequest("ses_1", CASCADE_ID, "gpt-6-luna")
    cascade.onIdle("ses_1", [])
    await cascade.pending
    expect(records()).toMatchObject([{ verdict: "error", judgeModel: "claude-haiku-5.5" }])
  })

  test("a new prompt starts a new turn that is judged again", async () => {
    const { cascade, calls } = make()
    for (const id of ["msg_1", "msg_2"]) {
      cascade.onPrompt("ses_1", id, "fix it")
      cascade.onPrimaryRequest("ses_1", CASCADE_ID, "gpt-6-luna")
      cascade.onPrimaryRequest("ses_1", CASCADE_ID, "gpt-6-luna")
      cascade.onIdle("ses_1", [])
      await cascade.pending
    }
    expect(calls).toEqual(["ses_1", "ses_1"])
  })
})

// Through the opencode 2 plugin: hooks recorded by a stand-in context.
describe("cascade in the opencode 2 plugin", () => {
  const fake = (id: string, wire: "responses" | "messages") => ({
    id,
    modelID: id,
    providerID: "github-copilot",
    name: id,
    family: id,
    package: wire === "messages" ? "@opencode/ai/providers/anthropic" : "aisdk:@ai-sdk/github-copilot",
    settings: { baseURL: COPILOT, endpoint: wire },
    enabled: true,
    variants: [],
  })
  const models = [fake("gpt-5.4", "responses"), fake("gpt-6-luna", "responses"), fake("claude-haiku-5.5", "messages")]

  async function load(options: Record<string, unknown>) {
    freshStateDir()
    const hooks = new Map<string, (event: any) => Promise<void> | void>()
    const store = new Map<string, any>()
    const generated: Array<{ sessionID: string; model: string }> = []
    const ctx = {
      options,
      integration: {
        connection: {
          active: async () => ({ integrationID: "github-copilot" }),
          resolve: async () => ({ type: "oauth", refresh: "bearer", access: "", expires: 0, metadata: {} }),
        },
      },
      model: {
        transform: async (callback: (editor: unknown) => void) => {
          const data = new Map(models.map((m) => [m.id, structuredClone(m) as any]))
          callback({
            list: () => [...data.values()],
            update: (_p: string, id: string, fn: (draft: any) => void) => {
              const draft = data.get(id) ?? {}
              fn(draft)
              draft.id = id
              data.set(id, draft)
            },
          })
          for (const [id, m] of data) store.set(id, m)
          return { dispose: async () => {} }
        },
      },
      session: {
        hook: async (name: string, callback: (event: any) => void) => {
          hooks.set(name, callback)
          return { dispose: async () => {} }
        },
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
        // As opencode: resolve the model with kind "generate", then answer.
        generate: async ({ sessionID }: { sessionID: string }) => {
          const event = { sessionID, agent: "build", kind: "generate", model: { id: CASCADE_ID, providerID: "github-copilot" } }
          await hooks.get("experimental.model.resolve")?.(event)
          generated.push({ sessionID, model: event.model.id })
          return { text: '{"verdict":"escalate","confidence":0.7,"reasons":["tests not run"]}', tokens: {}, cost: 0.002 }
        },
      },
    }
    await plugin.setup(ctx as never)
    return { hooks, store, generated }
  }

  async function withAuto<T>(fn: (tiers: string[]) => Promise<T>) {
    const orig = globalThis.fetch
    const tiers: string[] = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      tiers.push(JSON.parse(init?.body as string).tier)
      return Response.json({
        session_token: "tok",
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        selected_model: { id: "gpt-6-luna" },
      })
    }) as typeof fetch
    try {
      return await fn(tiers)
    } finally {
      globalThis.fetch = orig
    }
  }

  test("is off by default: no cascade auto and no experimental hooks", async () => {
    const { hooks, store } = await load({})
    expect(store.get(CASCADE_ID)).toBeUndefined()
    expect(hooks.has("experimental.idle")).toBe(false)
    expect(hooks.has("experimental.model.resolve")).toBe(false)
  })

  test("injects the cascade auto next to the other autos", async () => {
    const { store } = await load({ cascade: true })
    const auto = store.get(CASCADE_ID)
    expect(auto.name).toBe("Auto Cascade (experimental)")
    expect(auto.modelID).toBe("gpt-5.4")
  })

  test("drafts on the efficiency tier and the judge serves the generate request", async () => {
    await withAuto(async (tiers) => {
      const { hooks, generated } = await load({ cascade: true })
      const sessionID = "ses_1"
      await hooks.get("prompt")!({ sessionID, messageID: "msg_1", prompt: { text: "fix the bug", files: [] } })
      for (let i = 0; i < 2; i++) {
        const ref = { id: CASCADE_ID, providerID: "github-copilot" }
        await hooks.get("model.request")!({ sessionID, agent: "build", model: ref, kind: "primary", headers: {} })
      }
      expect(tiers).toEqual(["efficiency"])
      // The idle hook holds the Session until the verdict is in.
      await hooks.get("experimental.idle")!({ sessionID, background: [] })
      expect(generated).toEqual([{ sessionID, model: "claude-haiku-5.5" }])
      expect(records()).toMatchObject([
        { verdict: "escalate", judgeModel: "claude-haiku-5.5", draftModels: ["gpt-6-luna"], requests: 2, cost: 0.002 },
      ])
    })
  })

  test("leaves other generate requests on their own model", async () => {
    const { hooks } = await load({ cascade: true })
    const event = { sessionID: "ses_9", agent: "build", kind: "generate", model: { id: "auto", providerID: "github-copilot" } }
    await hooks.get("experimental.model.resolve")!(event)
    expect(event.model.id).toBe("auto")
  })
})

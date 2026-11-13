// Experimental cascade (opencode 2 >= 2.2.7), observe-only for now: `auto-cascade` drafts
// on the efficiency tier, and when a turn ends a judge model from another family
// reviews it. The verdict is only recorded (cascade.jsonl in the state directory);
// nothing escalates yet. This measures how often, and how well, a judge would
// escalate before anything acts on it.
//
// Flow: the `prompt` hook opens a turn, each primary model request on auto-cascade
// counts toward it, `experimental.idle` judges it through `session.generate` (full
// Session context plus the judge prompt, no history written, usage added to the
// Session), and `experimental.model.resolve` serves that generate request with the
// judge model.
import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { type AutoSpec, type CatalogModel, MODEL_ID, type Options, familyLabel, log, stateDir } from "./core"

export const CASCADE_ID = `${MODEL_ID}-cascade`

// A judge request that has not answered by then is recorded as a timeout; the
// request itself is not cancelled.
const JUDGE_TIMEOUT_MS = 120_000

// Names that mark a cheap, fast model in Copilot's catalog. Whole words only:
// "gemini" is not "mini".
const LIGHTWEIGHT = /\b(mini|flash|haiku|luna|nano|lite)\b/i

export const JUDGE_PROMPT = `You are a strict reviewer acting as a judge. Do not call any tools.

Review the assistant's most recent turn in the conversation above: everything since the user's latest request. Decide whether that work fully and correctly does what the user asked, or whether a stronger model should take over.

Escalate when the request is not fully done, the changes likely contain bugs, relevant tests failed or were not run where they should have been, the assistant made unjustified assumptions, or a change is unsafe. Accept when the work is complete and correct, even if its style could be better.

Answer with one JSON object and nothing else:
{"verdict": "accept" | "escalate", "confidence": <number from 0 to 1>, "reasons": ["<short reason>", ...]}`

export type CascadeOptions = { judge?: string; draft?: string }

export function cascadeOptions(options: Options): CascadeOptions | undefined {
  const value = options.cascade
  if (value === true) return {}
  if (value && typeof value === "object") return {
      judge: typeof value.judge === "string" ? value.judge : undefined,
      draft: typeof value.draft === "string" ? value.draft : undefined,
    }
  return undefined
}

// The cascade's draft auto: the efficiency tier on the other autos' anchor, or pinned
// to the configured `draft` model when the catalog has it enabled.
export function cascadeSpec(anchor: CatalogModel, catalog: CatalogModel[] = [], draft?: string): AutoSpec {
  const spec: AutoSpec = { id: CASCADE_ID, name: "Auto Cascade (experimental)", tier: "efficiency", anchor }
  if (!draft) return spec
  const wanted = draft.trim()
  const enabled = catalog.filter((m) => m.enabled)
  const pinned = enabled.find((m) => m.key === wanted) ?? enabled.find((m) => m.apiID === wanted)
  if (pinned) return { ...spec, anchor: pinned, pinned: true }
  log(`cascade: draft "${draft}" is not an enabled model; drafting through /auto`)
  return spec
}

// The configured judge if the catalog has it; otherwise an enabled model from
// another family than the draft (a second opinion, as Copilot Fusion uses),
// preferring a lightweight one.
export function pickJudge(catalog: CatalogModel[], draftApiID: string, preferred?: string): CatalogModel | undefined {
  const enabled = catalog.filter((m) => m.enabled)
  if (preferred) {
    const wanted = preferred.trim()
    const match = enabled.find((m) => m.key === wanted) ?? enabled.find((m) => m.apiID === wanted)
    if (match) return match
    log(`cascade: judge "${preferred}" is not an enabled model; picking one`)
  }
  const draftFamily = familyLabel(catalog.find((m) => m.apiID === draftApiID))
  const others = enabled.filter((m) => m.apiID !== draftApiID && (!draftFamily || familyLabel(m) !== draftFamily))
  const pool = others.length ? others : enabled.filter((m) => m.apiID !== draftApiID)
  const judge = pool.find((m) => LIGHTWEIGHT.test(`${m.apiID} ${m.name}`)) ?? pool[0]
  log(
    `cascade: judge ${judge?.apiID ?? "none"} for draft ${draftApiID} (${draftFamily ?? "?"}); enabled others: ${pool.map((m) => m.apiID).join(",")}; disabled: ${catalog
      .filter((m) => !m.enabled)
      .map((m) => m.apiID)
      .join(",")}`,
  )
  return judge
}

export type Verdict = {
  verdict: "accept" | "escalate" | "unparsed"
  confidence?: number
  reasons: string[]
}

// The judge's answer: the first JSON object in its text, which models sometimes wrap
// in a code fence or a sentence.
export function parseVerdict(text: string): Verdict {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      const verdict = typeof data.verdict === "string" ? data.verdict.trim().toLowerCase() : ""
      if (verdict === "accept" || verdict === "escalate") {
        const confidence = typeof data.confidence === "number" ? data.confidence : undefined
        const reasons = Array.isArray(data.reasons) ? data.reasons.filter((r): r is string => typeof r === "string") : []
        return { verdict, confidence, reasons }
      }
    } catch {}
  }
  return { verdict: "unparsed", reasons: text.trim() ? [text.trim().slice(0, 500)] : [] }
}

export type GenerateResult = {
  text: string
  tokens?: unknown
  cost?: number
}

export type CascadeDeps = {
  options: CascadeOptions
  catalog: () => CatalogModel[]
  // ctx.session.generate
  generate: (sessionID: string, prompt: string) => Promise<GenerateResult>
  // The Session's parent; subagent children are not judged.
  parentOf: (sessionID: string) => Promise<string | undefined>
}

// A user turn on auto-cascade, from its prompt to the Session going idle.
type Turn = {
  messageID: string
  prompt: string
  requests: number
  models: string[]
  judged: boolean
}

export type CascadeRecord = {
  at: string
  sessionID: string
  messageID: string
  prompt: string
  requests: number
  draftModels: string[]
  judgeModel?: string
  verdict: Verdict["verdict"] | "skipped" | "error" | "timeout"
  confidence?: number
  reasons: string[]
  tokens?: unknown
  cost?: number
  ms?: number
}

export class Cascade {
  private turns = new Map<string, Turn>()
  // Sessions whose generate request the judge serves, by judge model key.
  private judging = new Map<string, string>()
  // The latest judge run.
  pending: Promise<void> = Promise.resolve()

  constructor(private deps: CascadeDeps) {}

  onPrompt(sessionID: string, messageID: string, text: string) {
    this.turns.set(sessionID, { messageID, prompt: text, requests: 0, models: [], judged: false })
  }

  // A primary model request; only auto-cascade's count toward the turn.
  onPrimaryRequest(sessionID: string, autoID: string, modelID: string | undefined) {
    if (autoID !== CASCADE_ID) return
    const turn = this.turns.get(sessionID)
    if (!turn) return
    turn.requests++
    if (modelID && !turn.models.includes(modelID)) turn.models.push(modelID)
  }

  // experimental.model.resolve: serve the judge's generate request with the judge.
  resolveModel(event: { sessionID: string; kind: string; model: { id: string; providerID: string } }) {
    if (event.kind !== "generate") return
    const judge = this.judging.get(event.sessionID)
    if (!judge || event.model.id === judge) return
    log(`cascade: generate for ${event.sessionID} -> judge ${judge}`)
    event.model = { id: judge, providerID: event.model.providerID }
  }

  // experimental.idle: judge the finished turn, once. opencode awaits the hook, so the
  // Session stays busy until the verdict is in: a judge left running in the background
  // dies with a short-lived `opencode run`, and escalating needs the verdict before
  // the Session goes idle.
  onIdle(sessionID: string, background: readonly unknown[]): Promise<void> {
    const turn = this.turns.get(sessionID)
    if (!turn || turn.judged || turn.requests === 0) return Promise.resolve()
    // Background work wakes the Session again when it finishes; judge then.
    if (background.length) return Promise.resolve()
    turn.judged = true
    this.pending = this.judge(sessionID, turn).catch((error) => log(`cascade: judge failed: ${String(error)}`))
    return this.pending
  }

  private async judge(sessionID: string, turn: Turn) {
    const base = {
      at: new Date().toISOString(),
      sessionID,
      messageID: turn.messageID,
      prompt: turn.prompt.slice(0, 200),
      requests: turn.requests,
      draftModels: turn.models,
    }
    if (await this.deps.parentOf(sessionID).catch(() => undefined)) return
    // One request and no tool loop: an answer, not work worth a second opinion.
    if (turn.requests < 2) return record({ ...base, verdict: "skipped", reasons: ["single request"] })
    const draft = turn.models.at(-1) ?? ""
    const judge = pickJudge(this.deps.catalog(), draft, this.deps.options.judge)
    if (!judge) return record({ ...base, verdict: "error", reasons: ["no judge model available"] })

    this.judging.set(sessionID, judge.key)
    const started = Date.now()
    try {
      const result = await withTimeout(this.deps.generate(sessionID, JUDGE_PROMPT), JUDGE_TIMEOUT_MS)
      const ms = Date.now() - started
      if (!result) return record({ ...base, judgeModel: judge.apiID, verdict: "timeout", reasons: [], ms })
      const verdict = parseVerdict(result.text)
      await record({ ...base, judgeModel: judge.apiID, ...verdict, tokens: result.tokens, cost: result.cost, ms })
    } catch (error) {
      await record({ ...base, judgeModel: judge.apiID, verdict: "error", reasons: [String(error)], ms: Date.now() - started })
    } finally {
      this.judging.delete(sessionID)
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function cascadeLogFile() {
  return path.join(stateDir(), "cascade.jsonl")
}

async function record(entry: CascadeRecord) {
  log(
    `cascade: ${entry.sessionID} ${entry.verdict}${entry.judgeModel ? ` by ${entry.judgeModel}` : ""} (draft ${entry.draftModels.join(",") || "?"}, ${entry.requests} requests${entry.ms !== undefined ? `, ${entry.ms}ms` : ""})`,
  )
  const file = cascadeLogFile()
  await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined)
  await appendFile(file, `${JSON.stringify(entry)}\n`).catch(() => undefined)
}

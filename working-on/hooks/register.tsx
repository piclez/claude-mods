import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  Brief,
  Category,
  Entry,
  Health,
  Label,
  Labels,
  ModelPick,
  Route,
  RoutingMode,
  Spend,
  Task,
  TaskStatus,
} from '../types'

const PANE = 'working-on'
const TITLE = 'Working on'
const KEEP = 12
const CUT = 600
const MAX_TASKS = 5
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

// Bump a shape tag when that value's fields change: it declines what an older
// version stored, which outlives a reload.
const log = atom({ plugin: 'working-on', key: 'log' } as const, [] as Entry[], { shape: 'log-1' })
const brief = atom({ plugin: 'working-on', key: 'brief' } as const, null as Brief | null, { shape: 'brief-1' })
const labels = atom({ plugin: 'working-on', key: 'labels' } as const, { hash: '', byTask: {} } as Labels, { shape: 'labels-1' })
const spend = atom({ plugin: 'working-on', key: 'spend' } as const, { haikuIn: 0, haikuOut: 0, jevIn: 0, jevOut: 0 } as Spend, {
  shape: 'spend-1',
})
const health = atom({ plugin: 'working-on', key: 'health' } as const, { summary: 'waiting for the first turn', jev: '' } as Health, {
  shape: 'health-1',
})

const route = atom({ plugin: 'working-on', key: 'route' } as const, null as Route | null, { shape: 'route-1' })
const context = atom({ plugin: 'working-on', key: 'context' } as const, 0, { shape: 'context-1' })

const THEME = { title: '#e8e6f0', dim: '#7c7a86', active: '#f2c35b', done: '#7bd88f', blocked: '#ff7b7b', model: '#82aaff' }
const ICON: Record<TaskStatus, string> = { active: '●', done: '✓', blocked: '✗' }

export const CATEGORIES: Record<Category, { label: string; criterion: string }> = {
  bug_fix: { label: 'bug fix', criterion: 'Fixing behaviour that is wrong: a bug, a failing test, a broken page or report' },
  feature: { label: 'feature', criterion: 'Building something new: a feature, a pane, a page, an integration' },
  prod_ops: {
    label: 'prod/ops',
    criterion: 'Production operations: deploys, database migrations, secrets, environment variables, backups, rotating credentials',
  },
  pr_review: {
    label: 'PR review/CI',
    criterion: 'Pull request work: addressing review comments, merge conflicts, CI status, merging, branch cleanup',
  },
  billing: { label: 'billing/invoices', criterion: 'Invoices, billed hours, rates, payments or time tracking' },
  client_writing: {
    label: 'client writing',
    criterion: 'Text for a client to read: proposals, emails, statements of work, client pages, share links',
  },
  research: { label: 'research/question', criterion: 'Answering a question or investigating, with nothing to change yet' },
  other: { label: 'other', criterion: 'None of the other categories fits' },
}

export const MODELS: Record<ModelPick, { label: string; criterion: string }> = {
  haiku: { label: 'Haiku', criterion: 'Lookups, status checks and mechanical edits that need no judgment' },
  sonnet: { label: 'Sonnet', criterion: 'Routine features and bug fixes with a clear scope' },
  opus: {
    label: 'Opus',
    criterion: 'Production, schema, auth or money changes; multi-file debugging; code review',
  },
  fable: {
    label: 'Fable 5.1',
    criterion: 'The hardest open-ended work: architecture, ambiguous debugging, long-running tasks',
  },
}

const SUMMARY_SYSTEM = `You keep a short brief of what a coding session is working on, for a side panel.
Read the recent prompts ("you") and answers ("claude") and the previous brief.
Reply with JSON only, no prose, exactly: {"goal": string, "tasks": [{"title": string, "status": "active"|"done"|"blocked"}]}
- goal: one line, under 90 characters, what the person is trying to get done right now.
- tasks: at most ${MAX_TASKS}, most recent first; each title under 70 characters, in the person's own words.
- Keep a task's title exactly as in the previous brief while it is the same task, so its labels stay.
- Mark a task done only when an answer says it was finished.`

export function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'task'
}

/** Haiku's reply as a brief, or null when it isn't the JSON asked for. */
export function parseBrief(text: string): { goal: string; tasks: Task[] } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const { goal, tasks } = raw as { goal?: unknown; tasks?: unknown }
  if (typeof goal !== 'string' || !Array.isArray(tasks)) return null
  const seen = new Set<string>()
  const list: Task[] = []
  for (const t of tasks.slice(0, MAX_TASKS)) {
    if (!t || typeof t !== 'object') continue
    const { title, status } = t as { title?: unknown; status?: unknown }
    if (typeof title !== 'string' || !title.trim()) continue
    const id = slug(title)
    if (seen.has(id)) continue
    seen.add(id)
    const s: TaskStatus = status === 'done' || status === 'blocked' ? status : 'active'
    list.push({ id, title: title.trim().slice(0, 100), status: s })
  }
  return { goal: goal.trim().slice(0, 140), tasks: list }
}

/** One Jev request: two choice questions per task, all answered in parallel. */
export function jevRequest(b: Pick<Brief, 'goal' | 'tasks'>, recentPrompts: string[]) {
  const questions: Record<string, unknown> = {}
  const categoryCriteria = Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.criterion]))
  const modelCriteria = Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.criterion]))
  b.tasks.forEach((_, i) => {
    questions[`cat_${i}`] = {
      type: 'choice',
      instructions: `Which kind of work is the task \`tasks[${i}]\`, in a session whose goal is \`goal\`?`,
      criteria: categoryCriteria,
    }
    questions[`model_${i}`] = {
      type: 'choice',
      instructions: `Which Claude model fits the task \`tasks[${i}]\` best: the least capable one that can do it well?`,
      criteria: modelCriteria,
    }
  })
  return {
    model: 'jev-latest',
    state: { goal: b.goal, tasks: b.tasks.map(t => t.title), recent_prompts: recentPrompts },
    questions,
  }
}

type JevAnswer = { type?: string; choice?: string; confidence?: number | null }
type JevResponse = { answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number } }

/** Jev's answers as labels per task id; a task whose answers are missing gets none. */
export function readJevAnswers(tasks: Task[], body: JevResponse): Record<string, Label> {
  const out: Record<string, Label> = {}
  tasks.forEach((t, i) => {
    const cat = body.answers?.[`cat_${i}`]
    const model = body.answers?.[`model_${i}`]
    if (!cat?.choice || !model?.choice) return
    if (!(cat.choice in CATEGORIES) || !(model.choice in MODELS)) return
    out[t.id] = {
      category: cat.choice as Category,
      categoryConf: cat.confidence ?? null,
      model: model.choice as ModelPick,
      modelConf: model.confidence ?? null,
    }
  })
  return out
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > CUT ? `${flat.slice(0, CUT)}…` : flat
}

async function append($: EngineInterface, role: Entry['role'], text: string) {
  if (!text.trim()) return
  const at = await $.clock.now()
  await update($, log, list => {
    const n = (list.at(-1)?.n ?? 0) + 1
    return [...list, { n, role, text: cut(text), at }].slice(-KEEP)
  })
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// One refresh at a time, with at most one queued behind it. Module variables:
// a reload starts them over, which is what a reload should do.
let running = false
let again = false

async function summarize($: EngineInterface, force: boolean): Promise<Brief | null> {
  const entries = await read($, log)
  const prev = await read($, brief)
  const newest = entries.at(-1)?.n ?? 0
  if (!entries.length) return prev
  if (!force && prev && prev.lastN >= newest) return prev

  const transcript = entries.map(e => `${e.role}: ${e.text}`).join('\n')
  const previous = prev ? JSON.stringify({ goal: prev.goal, tasks: prev.tasks.map(({ title, status }) => ({ title, status })) }) : 'none'
  const r = await $.model.complete({
    model: 'haiku',
    system: SUMMARY_SYSTEM,
    prompt: `Previous brief: ${previous}\n\nRecent exchange:\n${transcript}`,
    maxTokens: 600,
  })
  await update($, spend, s => ({
    ...s,
    haikuIn: s.haikuIn + (r.usage?.input_tokens ?? 0),
    haikuOut: s.haikuOut + (r.usage?.output_tokens ?? 0),
  }))
  if (!r.isAnswered) {
    await update($, health, prev => ({ ...prev, summary: `summary failed (${r.reason})` }))
    return prev
  }
  const parsed = parseBrief(r.text)
  if (!parsed) {
    await update($, health, prev => ({ ...prev, summary: 'summary failed (not JSON)' }))
    return prev
  }
  const at = await $.clock.now()
  const next: Brief = { ...parsed, at, lastN: newest }
  await update($, brief, () => next)
  await update($, health, prev => ({ ...prev, summary: `updated ${clockTime(at)}` }))
  return next
}

async function label($: EngineInterface, options: PluginOptions, b: Brief, force: boolean) {
  const key = typeof options.typesafeApiKey === 'string' ? options.typesafeApiKey.trim() : ''
  if (!key) {
    await update($, health, prev => ({ ...prev, jev: 'Jev off: add a TypeSafe key in /config' }))
    return
  }
  if (!b.tasks.length) return
  const hash = b.tasks.map(t => t.id).join('|')
  const prev = await read($, labels)
  if (!force && prev.hash === hash) return

  const entries = await read($, log)
  const prompts = entries.filter(e => e.role === 'you').slice(-4).map(e => e.text.slice(0, 300))
  let res
  try {
    res = await $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(jevRequest(b, prompts)),
    })
  } catch {
    await update($, health, prev => ({ ...prev, jev: 'Jev unreachable' }))
    return
  }
  if (!res.ok) {
    const why = res.status === 401 || res.status === 403 ? 'key refused' : `HTTP ${res.status}`
    await update($, health, prev => ({ ...prev, jev: `Jev failed (${why})` }))
    return
  }
  let body: JevResponse
  try {
    body = JSON.parse(res.text) as JevResponse
  } catch {
    await update($, health, prev => ({ ...prev, jev: 'Jev failed (bad reply)' }))
    return
  }
  await update($, spend, s => ({
    ...s,
    jevIn: s.jevIn + (body.usage?.input_tokens ?? 0),
    jevOut: s.jevOut + (body.usage?.output_tokens ?? 0),
  }))
  await update($, labels, () => ({ hash, byTask: readJevAnswers(b.tasks, body) }))
  await update($, health, prev => ({ ...prev, jev: 'Jev labelled' }))
}

/** Summarize, then label. */
async function refresh($: EngineInterface, options: PluginOptions, force: boolean): Promise<void> {
  if (running) {
    again = true
    return
  }
  running = true
  try {
    const b = await summarize($, force)
    if (b) await label($, options, b, force)
  } finally {
    running = false
  }
  if (again) {
    again = false
    await refresh($, options, false)
  }
}


// ─── Routing ──────────────────────────────────────────────────────────

export const RANK: Record<ModelPick, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
export const MODEL_ID: Record<ModelPick, string> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'claude-fable-5-1' }
// Prompts that touch production or money never go below Opus, whatever Jev picks.
const FLOOR_CATEGORIES: ReadonlySet<Category> = new Set(['prod_ops', 'billing'])
export const MIN_CONF = 0.6
// Past this, a downgrade re-reads a long context uncached on the new model, and
// Haiku's window may not hold it; upgrades are still allowed.
export const BIG_CONTEXT = 150_000
const JEV_TIMEOUT_MS = 2500

/** The family a model id or alias belongs to, or null for one routing doesn't know. */
export function familyOf(model: string): ModelPick | null {
  const m = model.toLowerCase()
  for (const f of ['fable', 'opus', 'sonnet', 'haiku'] as const) if (m.includes(f)) return f
  return null
}

export type RouteInput = {
  pick: ModelPick
  pickConf: number | null
  category: Category | null
  categoryConf: number | null
  sessionModel: string
  contextTokens: number
}

/** `model` is what to send instead, or null to keep the session's model. */
export type RouteDecision = { model: string | null; target: ModelPick | null; reason: string }

function pctOf(conf: number | null): string {
  return conf == null ? '?' : `${Math.round(conf * 100)}%`
}

export function decideRoute(i: RouteInput): RouteDecision {
  const current = familyOf(i.sessionModel)
  if (!current) return { model: null, target: null, reason: `unknown session model ${i.sessionModel}` }

  // Auto never moves up to Fable by itself; a session already on Fable may stay.
  let target: ModelPick = i.pick === 'fable' && current !== 'fable' ? 'opus' : i.pick
  const floored = i.category !== null && FLOOR_CATEGORIES.has(i.category) && (i.categoryConf ?? 0) >= 0.5
  if (floored && RANK[target] < RANK.opus) target = 'opus'

  if (!floored && (i.pickConf ?? 0) < MIN_CONF) {
    return { model: null, target: current, reason: `Jev unsure (${pctOf(i.pickConf)})` }
  }
  if (RANK[target] < RANK[current] && i.contextTokens > BIG_CONTEXT) {
    return { model: null, target: current, reason: `context ${Math.round(i.contextTokens / 1000)}k too big to downgrade` }
  }
  if (target === current) return { model: null, target, reason: floored ? 'Opus floor' : 'already on it' }
  return { model: MODEL_ID[target], target, reason: floored ? 'Opus floor' : `Jev ${pctOf(i.pickConf)}` }
}

export function routingMode(options: PluginOptions): RoutingMode {
  return options.routing === 'off' || options.routing === 'auto' ? options.routing : 'suggest'
}

function apiKey(options: PluginOptions): string {
  return typeof options.typesafeApiKey === 'string' ? options.typesafeApiKey.trim() : ''
}

/** The Jev request for one prompt: what kind of work it is and which model should answer it. */
export function routeRequest(prompt: string, b: Brief | null) {
  return {
    model: 'jev-latest',
    state: {
      prompt: prompt.slice(0, 1500),
      goal: b?.goal ?? '',
      open_tasks: (b?.tasks ?? []).filter(t => t.status === 'active').map(t => t.title),
    },
    questions: {
      category: {
        type: 'choice',
        instructions: 'Which kind of work does `prompt` ask for, in a session whose goal is `goal`?',
        criteria: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.criterion])),
      },
      model: {
        type: 'choice',
        instructions: 'Which Claude model should answer `prompt`: the least capable one that can do it well?',
        criteria: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.criterion])),
      },
    },
  }
}

// The model each main-loop turn runs on, set at turn.start and read by every
// turn.step of that turn, so a turn never flips models between tool calls.
const routes = new Map<string, string>()

async function routeTurn($: EngineInterface, options: PluginOptions, mode: RoutingMode, turnId: string, text: string) {
  const key = apiKey(options)
  if (!key) {
    $.ui.status('routing needs a TypeSafe key')
    return
  }
  const body = JSON.stringify(routeRequest(text, await read($, brief)))
  const call = $.http
    .fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    })
    .catch(() => null)
  const res = await Promise.race([call, $.clock.sleep(JEV_TIMEOUT_MS).then(() => 'timeout' as const)])
  if (res === 'timeout' || res === null || !res.ok) {
    const why = res === 'timeout' ? 'timed out' : res === null ? 'unreachable' : `HTTP ${res.status}`
    await update($, health, prev => ({ ...prev, jev: `routing skipped (Jev ${why})` }))
    return
  }
  let parsed: JevResponse
  try {
    parsed = JSON.parse(res.text) as JevResponse
  } catch {
    await update($, health, prev => ({ ...prev, jev: 'routing skipped (bad Jev reply)' }))
    return
  }
  await update($, spend, s => ({
    ...s,
    jevIn: s.jevIn + (parsed.usage?.input_tokens ?? 0),
    jevOut: s.jevOut + (parsed.usage?.output_tokens ?? 0),
  }))
  const cat = parsed.answers?.category
  const pickAns = parsed.answers?.model
  if (!pickAns?.choice || !(pickAns.choice in MODELS)) return
  const pick = pickAns.choice as ModelPick
  const category = cat?.choice && cat.choice in CATEGORIES ? (cat.choice as Category) : null

  const sessionModel = await $.session.model()
  const d = decideRoute({
    pick,
    pickConf: pickAns.confidence ?? null,
    category,
    categoryConf: cat?.confidence ?? null,
    sessionModel,
    contextTokens: await read($, context),
  })
  const switching = mode === 'auto' && d.model !== null
  if (switching && d.model) routes.set(turnId, d.model)

  const from = familyOf(sessionModel)
  const to = switching && d.target ? d.target : from ?? pick
  await update($, route, () => ({
    turnId,
    from: from ?? sessionModel,
    to,
    shown: pick,
    conf: pickAns.confidence ?? null,
    category,
    reason: d.reason,
    auto: mode === 'auto',
  }))

  const catLabel = category ? ` · ${CATEGORIES[category].label}` : ''
  const pickText = `${MODELS[pick].label} ${pctOf(pickAns.confidence ?? null)}${catLabel}`
  if (switching && d.target) {
    $.ui.status(`routed → ${MODELS[d.target].label} (${d.reason})`)
    void $.ui.toast(`Routed to ${MODELS[d.target].label} (${d.reason}${catLabel})`)
  } else if (mode === 'auto') {
    $.ui.status(`stays on ${from ? MODELS[from].label : sessionModel}: ${d.reason}`)
  } else {
    $.ui.status(`Jev → ${pickText}`)
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'working-on',
      description: 'Show what this session is working on, refreshed now',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'working-on' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    // A timer, not this dispatch: the Haiku and Jev calls outlive the command.
    $.clock.after(0, () => void refresh($, options, true))
    return { text: opened.isPlaced ? 'Working-on pane opened; refreshing.' : 'Working-on pane will show once the terminal is wider.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && !e.command && !e.text.trim().startsWith('/')) await append($, 'you', e.text)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const mode = routingMode(options)
    const text = e.text.trim()
    if (!e.agentId && mode !== 'off' && text && !text.startsWith('/')) {
      try {
        await routeTurn($, options, mode, e.turnId, text)
      } catch {
        // Routing is best-effort: a failure leaves the turn on the session's model.
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const model = e.agentId ? undefined : routes.get(e.turnId)
    const result = yield* next(model ? { ...e, model } : e)
    // Each request's own usage is the conversation's size; turn.complete's is a sum.
    if (!e.agentId && result.usage) {
      const u = result.usage
      const size = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, context, () => size)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) routes.delete(e.turnId)
    const done = await next(e)
    // Subagent turns carry an agentId; only the main conversation feeds the brief.
    if (!e.agentId && e.reason === 'answer' && !e.isAborted) {
      await append($, 'claude', e.answer)
      $.clock.after(0, () => void refresh($, options, false))
    }
    return done
  })

  const modelName = (family: string) => (family in MODELS ? MODELS[family as ModelPick].label : family)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, brief)
    const l = await read($, labels)
    const s = await read($, spend)
    const status = await read($, health)

    const footer = (
      <Box flexDirection="column" marginTop={1}>
        <Text color={THEME.dim} wrap="wrap">{[status.summary, status.jev].filter(Boolean).join(' · ')}</Text>
        <Text color={THEME.dim}>{`haiku ${tokens(s.haikuIn + s.haikuOut)} tok · jev ${tokens(s.jevIn + s.jevOut)} tok`}</Text>
      </Box>
    )

    const mode = routingMode(options)
    const r = await read($, route)
    const routingText =
      mode === 'off'
        ? 'Routing: off'
        : !r
          ? `Routing: ${mode} · waiting for a prompt`
          : r.auto
            ? `Routing: auto · this turn ${modelName(r.to)}${r.to !== r.from ? ` (was ${modelName(r.from)})` : ''} · ${r.reason}`
            : `Routing: suggest · Jev: ${MODELS[r.shown].label} ${pctOf(r.conf)}`
    const routingRow = (
      <Text color={THEME.model} wrap="wrap">
        {routingText}
      </Text>
    )

    if (!b) {
      return (
        <Box flexDirection="column">
          {routingRow}
          <Text color={THEME.dim} wrap="wrap">The brief appears after the next answer. /working-on refreshes it now.</Text>
          {footer}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text color={THEME.title} bold wrap="wrap">{b.goal}</Text>
        {routingRow}
        {b.tasks.map(t => {
          const lab = l.byTask[t.id]
          const unsure = lab && ((lab.modelConf ?? 1) < 0.5 || (lab.categoryConf ?? 1) < 0.5)
          const pct = lab?.modelConf != null ? ` ${Math.round(lab.modelConf * 100)}%` : ''
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text color={THEME[t.status]} wrap="wrap">{`${ICON[t.status]} ${t.title}`}</Text>
              {lab ? (
                <Text color={unsure ? THEME.dim : THEME.model} wrap="wrap">
                  {`  ${CATEGORIES[lab.category].label} · → ${MODELS[lab.model].label}${pct}`}
                </Text>
              ) : null}
            </Box>
          )
        })}
        {footer}
      </Box>
    )
  })
}

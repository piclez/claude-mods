import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { jevRequest, parseBrief, readJevAnswers } from '../hooks/register'

const PANE = {
  plugin: 'working-on',
  component: 'Pane',
  requestId: 'working-on',
  props: {
    title: 'Working on',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const HAIKU_REPLY = JSON.stringify({
  goal: 'Fix the Acme invoices and land the open PRs',
  tasks: [
    { title: 'Rewrite Acme September invoice lines', status: 'done' },
    { title: 'Merge PR 61 after prod migrations', status: 'active' },
  ],
})

const JEV_REPLY = JSON.stringify({
  model: 'jev-latest',
  answers: {
    cat_0: { type: 'choice', choice: 'billing', confidence: 0.91 },
    model_0: { type: 'choice', choice: 'sonnet', confidence: 0.8 },
    cat_1: { type: 'choice', choice: 'prod_ops', confidence: 0.88 },
    model_1: { type: 'choice', choice: 'opus', confidence: 0.74 },
  },
  usage: { input_tokens: 900, output_tokens: 20 },
})

/** The engine beneath the plugin: a session, Haiku, and TypeSafe answering `jev`. */
function engine(on: On, jev: { status: number; text: string } | 'throw' = { status: 200, text: JEV_REPLY }) {
  const calls = { haiku: 0, jev: [] as { url: string; body: unknown; auth?: string }[] }
  on('command.register', () => ({ value: { command: 'working-on' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', () => {
    calls.haiku += 1
    return { value: { isAnswered: true, text: HAIKU_REPLY, usage: { input_tokens: 2000, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('http.fetch', (_, e) => {
    calls.jev.push({ url: e.url, body: JSON.parse(e.init?.body ?? '{}'), auth: e.init?.headers?.Authorization })
    if (jev === 'throw') throw new Error('offline')
    return { value: { status: jev.status, ok: jev.status < 300, headers: {}, text: jev.text } }
  })
  return calls
}

async function aTurn($: Engine, prompt: string, answer: string) {
  await $.prompt.submit({ text: prompt, wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: `t-${prompt}`, reason: 'answer' })
}

test('a turn summarizes with Haiku, then Jev labels each task', { options: { typesafeApiKey: 'ts_test' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const calls = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await aTurn($, 'fix the acme invoices', 'Rewrote the September lines.')
  await clock.advance(0)

  expect(calls.haiku).toBe(1)
  expect(calls.jev).toHaveLength(1)
  expect(calls.jev[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(calls.jev[0]?.auth).toBe('Bearer ts_test')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Fix the Acme invoices/ }))?.text).toBe('Fix the Acme invoices and land the open PRs')
    expect((await ui.find({ type: 'Text', text: /prod\/ops/ }))?.text).toContain('→ Opus 74%')
    expect((await ui.find({ type: 'Text', text: /billing\/invoices/ }))?.text).toContain('→ Sonnet 80%')
    await ui.unmount()
  }
})

test('nothing new since the last refresh skips Haiku and Jev', { options: { typesafeApiKey: 'ts_test' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await aTurn($, 'fix the acme invoices', 'Done.')
  await clock.advance(0)

  // A subagent's turn doesn't feed the brief, so it adds nothing to refresh.
  await $.turn.complete({ answer: 'sub', durationMs: 1, isAborted: false, turnId: 'sub', reason: 'answer', agentId: 'a1' })
  await clock.advance(0)

  expect(calls.haiku).toBe(1)
  expect(calls.jev).toHaveLength(1)
})

test('without a key the summary shows and Jev is off', async ($, on) => {
  const clock = mock.clock(on)
  const calls = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await aTurn($, 'fix the acme invoices', 'Done.')
  await clock.advance(0)

  expect(calls.jev).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fix the Acme invoices/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Jev off/ }))?.text).toContain('add a TypeSafe key in /config')
  await ui.unmount()
})

for (const [name, jev, says] of [
  ['a refused key', { status: 401, text: '{}' }, 'Jev failed (key refused)'],
  ['a server error', { status: 500, text: '{}' }, 'Jev failed (HTTP 500)'],
  ['no network', 'throw', 'Jev unreachable'],
] as const) {
  test(`${name} leaves the summary up and says why`, { options: { typesafeApiKey: 'ts_test' } }, async ($, on) => {
    const clock = mock.clock(on)
    engine(on, jev)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await aTurn($, 'fix the acme invoices', 'Done.')
    await clock.advance(0)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Fix the Acme invoices/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: new RegExp(says.replace(/[()]/g, '\\$&')) }))?.text).toContain(says)
    expect(await ui.find({ type: 'Text', text: /→/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('the empty pane says when the brief will appear', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /next answer/ }))?.text).toContain('/working-on refreshes it now')
  await ui.unmount()
})

test('parseBrief reads JSON wrapped in prose, caps tasks and drops junk', async () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ title: `Task ${i}`, status: i === 0 ? 'done' : 'weird' }))
  const parsed = parseBrief(`Here you go:\n${JSON.stringify({ goal: 'G', tasks: [...tasks, { status: 'active' }] })}\nThanks`)
  expect(parsed?.tasks).toHaveLength(5)
  expect(parsed?.tasks[0]).toEqual({ id: 'task-0', title: 'Task 0', status: 'done' })
  expect(parsed?.tasks[1]?.status).toBe('active')
  expect(parseBrief('not json')).toBeNull()
  expect(parseBrief('{"goal": 3, "tasks": []}')).toBeNull()
})

test('jevRequest asks a category and a model per task, against named state', async () => {
  const req = jevRequest(
    { goal: 'G', tasks: [{ id: 'a', title: 'A', status: 'active' }, { id: 'b', title: 'B', status: 'done' }] },
    ['p1'],
  )
  expect(Object.keys(req.questions).sort()).toEqual(['cat_0', 'cat_1', 'model_0', 'model_1'])
  expect(req.state).toEqual({ goal: 'G', tasks: ['A', 'B'], recent_prompts: ['p1'] })
  expect(JSON.stringify(req.questions.model_1)).toContain('`tasks[1]`')
  expect(Object.keys((req.questions.model_0 as { criteria: object }).criteria)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
})

test('readJevAnswers ignores answers outside the defined options', async () => {
  const tasks = [{ id: 'a', title: 'A', status: 'active' as const }, { id: 'b', title: 'B', status: 'active' as const }]
  const out = readJevAnswers(tasks, {
    answers: {
      cat_0: { choice: 'feature', confidence: 0.6 },
      model_0: { choice: 'fable', confidence: 0.55 },
      cat_1: { choice: 'astrology' },
      model_1: { choice: 'opus' },
    },
  })
  expect(out).toEqual({ a: { category: 'feature', categoryConf: 0.6, model: 'fable', modelConf: 0.55 } })
})

// ─── Routing ──────────────────────────────────────────────────────────

import { decideRoute, routeRequest } from '../hooks/register'

const base = {
  pick: 'sonnet' as const,
  pickConf: 0.82,
  category: 'research' as const,
  categoryConf: 0.9,
  sessionModel: 'claude-opus-5-5',
  contextTokens: 20_000,
}

test('decideRoute switches on a confident pick', async () => {
  expect(decideRoute(base)).toEqual({ model: 'sonnet', target: 'sonnet', reason: 'Jev 82%' })
})

test('decideRoute keeps the model when Jev is unsure', async () => {
  expect(decideRoute({ ...base, pickConf: 0.55 }).model).toBeNull()
  expect(decideRoute({ ...base, pickConf: 0.55 }).reason).toBe('Jev unsure (55%)')
})

test('decideRoute floors prod and billing at Opus, even when unsure', async () => {
  const prod = decideRoute({ ...base, pick: 'haiku', pickConf: 0.4, category: 'prod_ops', sessionModel: 'claude-sonnet-5-5' })
  expect(prod).toEqual({ model: 'opus', target: 'opus', reason: 'Opus floor' })
  const billingOnOpus = decideRoute({ ...base, pick: 'haiku', category: 'billing' })
  expect(billingOnOpus.model).toBeNull()
  expect(billingOnOpus.reason).toBe('Opus floor')
})

test('decideRoute blocks a downgrade in a big context but allows an upgrade', async () => {
  const down = decideRoute({ ...base, contextTokens: 180_000 })
  expect(down.model).toBeNull()
  expect(down.reason).toContain('too big to downgrade')
  const up = decideRoute({ ...base, pick: 'opus', sessionModel: 'sonnet', contextTokens: 180_000 })
  expect(up.model).toBe('opus')
})

test('decideRoute never moves up to Fable, but leaves a Fable session on Fable', async () => {
  expect(decideRoute({ ...base, pick: 'fable', pickConf: 0.95 }).model).toBeNull()
  expect(decideRoute({ ...base, pick: 'fable', pickConf: 0.95, sessionModel: 'sonnet' }).model).toBe('opus')
  expect(decideRoute({ ...base, pick: 'fable', pickConf: 0.95, sessionModel: 'claude-fable-5-1' }).model).toBeNull()
})

test('decideRoute leaves an unknown session model alone', async () => {
  expect(decideRoute({ ...base, sessionModel: 'some-gateway-model' }).model).toBeNull()
})

test('routeRequest asks a category and a model about the prompt', async () => {
  const req = routeRequest('x'.repeat(2000), { goal: 'G', tasks: [{ id: 'a', title: 'A', status: 'active' }], at: 0, lastN: 1 })
  expect(Object.keys(req.questions)).toEqual(['category', 'model'])
  expect(req.state.prompt).toHaveLength(1500)
  expect(req.state.open_tasks).toEqual(['A'])
})

type Pick = { pick: string; pickConf: number; category: string; catConf: number }

/** The engine beneath the plugin for routing: Jev answers `pick`; turn.step records each request's model. */
function routingEngine(on: On, opts: { sessionModel?: string; jev?: Pick | 'hang' } = {}) {
  const seen = { models: [] as string[], fetches: 0, status: [] as (string | undefined)[], toasts: [] as string[] }
  const jev = opts.jev ?? { pick: 'sonnet', pickConf: 0.82, category: 'research', catConf: 0.9 }
  on('command.register', () => ({ value: { command: 'working-on' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: opts.sessionModel ?? 'claude-opus-5-5' }))
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    seen.models.push(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('http.fetch', () => {
    seen.fetches += 1
    if (jev === 'hang') return new Promise<never>(() => {})
    const text = JSON.stringify({
      answers: {
        category: { type: 'choice', choice: jev.category, confidence: jev.catConf },
        model: { type: 'choice', choice: jev.pick, confidence: jev.pickConf },
      },
      usage: { input_tokens: 300, output_tokens: 4 },
    })
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  return seen
}

async function step($: Engine, turnId: string, model: string, agentId?: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model, messageCount: 3, ...(agentId ? { agentId } : {}) })) {
    // the stub streams nothing; the result is what the test checks
  }
}

const ON = { options: { typesafeApiKey: 'ts_test', routing: 'auto' } } as const

test('auto routes the main turn, every step of it, and not a subagent', ON, async ($, on) => {
  mock.clock(on)
  const seen = routingEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'what does git status say?', turnId: 't1' })
  await step($, 't1', 'claude-opus-5-5')
  await step($, 't1', 'claude-opus-5-5')
  await step($, 't1', 'claude-opus-5-5', 'sub-1')

  expect(seen.models).toEqual(['sonnet', 'sonnet', 'claude-opus-5-5'])
  expect(seen.toasts[0]).toContain('Routed to Sonnet')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Routing: auto/ }))?.text).toContain('this turn Sonnet (was Opus)')
  await ui.unmount()
})

test('suggest shows the pick and leaves the model alone', { options: { typesafeApiKey: 'ts_test', routing: 'suggest' } }, async ($, on) => {
  mock.clock(on)
  const seen = routingEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'what does git status say?', turnId: 't1' })
  await step($, 't1', 'claude-opus-5-5')

  expect(seen.models).toEqual(['claude-opus-5-5'])
  expect(seen.status).toContain('Jev → Sonnet 82% · research/question')
  expect(seen.toasts).toEqual([])
})

test('off makes no Jev call', { options: { typesafeApiKey: 'ts_test', routing: 'off' } }, async ($, on) => {
  mock.clock(on)
  const seen = routingEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'what does git status say?', turnId: 't1' })
  await step($, 't1', 'claude-opus-5-5')
  expect(seen.fetches).toBe(0)
  expect(seen.models).toEqual(['claude-opus-5-5'])
})

test('a prod prompt is floored to Opus in auto', ON, async ($, on) => {
  mock.clock(on)
  const seen = routingEngine(on, {
    sessionModel: 'claude-sonnet-5-5',
    jev: { pick: 'haiku', pickConf: 0.9, category: 'prod_ops', catConf: 0.92 },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'apply the migration to prod', turnId: 't1' })
  await step($, 't1', 'claude-sonnet-5-5')
  expect(seen.models).toEqual(['opus'])
})

test('a Jev that never answers leaves the turn on its model', ON, async ($, on) => {
  const clock = mock.clock(on)
  const seen = routingEngine(on, { jev: 'hang' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const started = $.turn.start({ text: 'what does git status say?', turnId: 't1' })
  await clock.advance(2500)
  await started
  await step($, 't1', 'claude-opus-5-5')
  expect(seen.models).toEqual(['claude-opus-5-5'])
})

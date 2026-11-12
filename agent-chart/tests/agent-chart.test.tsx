import { expect, mock, test } from 'claude-code/testing'

import { barCells, byType, formatDuration, graphLines } from '../hooks/register'

const PANE = {
  component: 'Pane',
  requestId: 'agent-chart',
  props: { title: 'Subagents', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  viewport: { columns: 160, rows: 40 },
} as const

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Find the chess wrapper',
  description: 'find chess wrapper',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

test('formats durations', () => {
  expect(formatDuration(4_200)).toBe('4s')
  expect(formatDuration(65_000)).toBe('1m05s')
})

test('places bars on the shared timeline', () => {
  const run = { id: 'a', type: 'Explore', description: '', isBackground: false, startedAt: 5_000, endedAt: 10_000, status: 'done', toolCount: 0 } as const
  expect(barCells(run, 0, 10_000, 20)).toEqual({ pad: 10, len: 10 })
})

test('groups time by type and nests spawns under their parent', () => {
  const base = { description: '', isBackground: false, status: 'done', toolCount: 0 } as const
  const list = [
    { ...base, id: 'a', type: 'Explore', startedAt: 0, endedAt: 4_000 },
    { ...base, id: 'b', type: 'Plan', startedAt: 0, endedAt: 9_000 },
    { ...base, id: 'c', type: 'Explore', startedAt: 1_000, endedAt: 3_000, parentId: 'b' },
  ]
  expect(byType(list, 10_000)).toEqual([
    { type: 'Plan', count: 1, ms: 9_000 },
    { type: 'Explore', count: 2, ms: 6_000 },
  ])
  expect(graphLines(list).map(l => `${l.prefix}${l.run.id}`)).toEqual([' ├─ a', ' └─ b', '    └─ c'])
})

test('an invoked subagent shows as running, then done', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', async () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'agent-chart', surface, ...PANE })
    expect(await empty.find({ text: /shows up here as it starts/ })).toBeDefined()
    await empty.unmount()
  }

  const started = await $.agent.spawn(SPAWN)
  expect(started.agentId).toBe('agent-1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-chart', surface, ...PANE })
    expect(await ui.find({ text: /1 running/ })).toBeDefined()
    expect(await ui.find({ text: /find chess wrapper/ })).toBeDefined()
    expect(await ui.find({ text: /thinking/ })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(3_000)
  await $.turn.complete({ answer: 'found it', durationMs: 3000, isAborted: false, turnId: 't1', agentId: 'agent-1', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-chart', surface, ...PANE })
    expect(await ui.find({ text: /0 running/ })).toBeDefined()
    expect(await ui.find({ text: /1 done/ })).toBeDefined()
    expect(await ui.find({ text: /✓/ })).toBeDefined()
    expect(await ui.find({ text: /3s/ })).toBeDefined()
    expect(await ui.find({ text: /0 tools · done/ })).toBeDefined()
    expect(await ui.find({ text: /Agent graph/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a new session registers /agent-chart, and running it opens the pane', async ($, on) => {
  mock.clock(on)
  const registered: string[] = []
  const opened: string[] = []
  on('command.register', async ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', async ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })

  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(registered).toContain('agent-chart')

  const out = await $.command.run({ command: 'agent-chart', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(opened).toContain('agent-chart')
  expect(out.text).toContain('opened')
})

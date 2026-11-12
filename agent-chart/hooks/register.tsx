import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentRun, AgentRunStatus } from '../types'

const PANE = 'agent-chart'
const TITLE = 'Subagents'
const KEEP = 60

const runs = atom({ plugin: 'agent-chart', key: 'runs' } as const, [])
const now = atom({ plugin: 'agent-chart', key: 'now' } as const, 0)

const THEME = {
  card: '#3a3a44',
  title: '#e8e6f0',
  dim: '#7c7a86',
  track: '#34343c',
  rowRunning: '#2c2639',
  main: '#f0a050',
}

const ICON: Record<AgentRunStatus, string> = { running: '▶', done: '✓', failed: '✗', stopped: '■' }
const STATUS: Record<AgentRunStatus, { fg: string; bg: string }> = {
  running: { fg: '#f2c35b', bg: '#3b3220' },
  done: { fg: '#7bd88f', bg: '#1f3628' },
  failed: { fg: '#ff7b7b', bg: '#3d2326' },
  stopped: { fg: '#9a98a3', bg: '#2e2e34' },
}

const TYPE_COLORS: Record<string, string> = {
  Explore: '#9d8cff',
  'general-purpose': '#5fc9c0',
  Plan: '#f2c35b',
  claude: '#f0a050',
}
const SPARE_COLORS = ['#ff79c6', '#82aaff', '#7bd88f', '#ffb86c', '#c3a6ff']

export function typeColor(type: string): string {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type]
  let h = 0
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return SPARE_COLORS[h % SPARE_COLORS.length] ?? '#82aaff'
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

/**
 * One timeline row: blank up to the run's start, then a bar to its end (or now),
 * scaled so the window from the earliest shown start to now fills `width` cells.
 */
export function barCells(run: AgentRun, from: number, to: number, width: number): { pad: number; len: number } {
  const span = Math.max(to - from, 1000)
  const start = Math.round(((run.startedAt - from) / span) * width)
  const end = Math.round((((run.endedAt ?? to) - from) / span) * width)
  const pad = Math.min(Math.max(start, 0), width - 1)
  return { pad, len: Math.max(1, Math.min(end, width) - pad) }
}

/** Runs and total time per agent type, busiest first. */
export function byType(list: readonly AgentRun[], to: number): { type: string; count: number; ms: number }[] {
  const out = new Map<string, { type: string; count: number; ms: number }>()
  for (const r of list) {
    const t = out.get(r.type) ?? { type: r.type, count: 0, ms: 0 }
    t.count++
    t.ms += (r.endedAt ?? to) - r.startedAt
    out.set(r.type, t)
  }
  return [...out.values()].sort((a, b) => b.ms - a.ms)
}

/** Depth-first lines of the spawn tree under `main`, children in start order. */
export function graphLines(list: readonly AgentRun[]): { run: AgentRun; prefix: string }[] {
  const ids = new Set(list.map(r => r.id))
  const kids = new Map<string, AgentRun[]>()
  for (const r of list) {
    const parent = r.parentId && ids.has(r.parentId) ? r.parentId : 'main'
    kids.set(parent, [...(kids.get(parent) ?? []), r])
  }
  const lines: { run: AgentRun; prefix: string }[] = []
  const walk = (id: string, indent: string) => {
    const children = kids.get(id) ?? []
    children.forEach((run, i) => {
      const last = i === children.length - 1
      lines.push({ run, prefix: `${indent}${last ? '└─' : '├─'} ` })
      walk(run.id, `${indent}${last ? '   ' : '│  '}`)
    })
  }
  walk('main', ' ')
  return lines
}

const statusOf = (reason: string): AgentRunStatus =>
  reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'

async function showStatus($: EngineInterface) {
  const list = await read($, runs)
  const running = list.filter(r => r.status === 'running').length
  $.ui.status(running ? `${running} subagent${running === 1 ? '' : 's'} running` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-chart', description: 'Show the subagent timeline pane' })
    // Bars of running agents grow with the clock; tick only while one runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, runs)
        if (!list.some(r => r.status === 'running')) return
        const t = await $.clock.now()
        await update($, now, () => t)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'agent-chart' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return { text: opened.isPlaced ? 'Subagent timeline opened.' : 'Subagent timeline will show once the terminal is wider.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const agentId = result.agentId
    if (!agentId) return result
    const startedAt = await $.clock.now()
    const run: AgentRun = {
      id: agentId,
      type: e.subagentType,
      description: e.description,
      model: result.model,
      parentId: e.parentAgentId,
      isBackground: e.background,
      startedAt,
      status: 'running',
      toolCount: 0,
    }
    await update($, runs, list => [...list.filter(r => r.id !== agentId), run].slice(-KEEP))
    await update($, now, () => startedAt)
    // Unasked, a pane only seats on wide terminals; /agent-chart opens it anywhere.
    $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
    await showStatus($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      await update($, runs, list =>
        list.map(r =>
          r.id === agentId ? { ...r, toolCount: r.toolCount + 1, lastTool: String(e.tool), status: 'running', endedAt: undefined } : r,
        ),
      )
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const endedAt = await $.clock.now()
      await update($, runs, list =>
        list.map(r =>
          r.id === agentId
            ? { ...r, endedAt, status: statusOf(e.reason), outputTokens: (r.outputTokens ?? 0) + (e.usage?.output_tokens ?? 0) }
            : r,
        ),
      )
      await update($, now, () => endedAt)
      await showStatus($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const tick = await read($, now)
    const width = Math.max(28, e.props.bodyColumns)
    const inner = width - 4
    const budget = Math.max(12, (e.viewport?.rows ?? 32) - 3)

    const count = (s: AgentRunStatus) => list.filter(r => r.status === s).length
    const chip = (s: AgentRunStatus, label: string) => (
      <Text backgroundColor={STATUS[s].bg} color={STATUS[s].fg} bold>{` ${label} `}</Text>
    )

    const card = (title: string, right: string, body: RenderChildren) => (
      <Box flexDirection="column" borderStyle="round" borderColor={THEME.card} paddingX={1} marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={THEME.title} bold>{title}</Text>
          <Text color={THEME.dim}>{right}</Text>
        </Box>
        {body}
      </Box>
    )

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={THEME.title} bold>Subagents</Text>
          <Text color={THEME.dim}>{`${list.length} this session`}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          {chip('running', `● ${count('running')} running`)}
          {chip('done', `✓ ${count('done')} done`)}
          {chip('failed', `✗ ${count('failed') + count('stopped')} stopped`)}
        </Box>
      </Box>
    )

    if (!list.length) {
      return (
        <Box flexDirection="column">
          {header}
          {card('Live spawns', 'none yet', (
            <Box flexDirection="column">
              <Text color={THEME.dim}>Each subagent shows up here as it starts.</Text>
              <Text color={THEME.dim} wrap="wrap">Try: "Use 3 Explore agents in parallel to map this repo."</Text>
            </Box>
          ))}
        </Box>
      )
    }

    const to = Math.max(tick, ...list.map(r => r.endedAt ?? r.startedAt))
    const types = byType(list, to)
    const graph = graphLines(list)

    // Room left for live rows (two lines each) after the optional cards.
    let typeRows = 3 + Math.min(types.length, 4) + 1
    let graphRows = 3 + Math.min(graph.length, 6) + 2
    let liveRoom = budget - 3 - 4 - typeRows - graphRows
    if (liveRoom < 4) {
      liveRoom += graphRows
      graphRows = 0
    }
    if (liveRoom < 4) {
      liveRoom += typeRows
      typeRows = 0
    }
    const shown = list.slice(-Math.max(1, Math.floor(liveRoom / 2)))
    const from = Math.min(...shown.map(r => r.startedAt))

    const live = card('Live spawns', `window ${formatDuration(to - from)}`, (
      <Box flexDirection="column">
        {shown.map((run, i) => {
          const st = STATUS[run.status]
          const elapsed = formatDuration((run.endedAt ?? to) - run.startedAt)
          const doing = run.status === 'running' ? (run.lastTool ?? 'thinking') : run.status
          const meta = ` ${run.toolCount} tool${run.toolCount === 1 ? '' : 's'} · ${doing}`
          const barWidth = Math.max(6, inner - meta.length)
          const { pad, len } = barCells(run, from, to, barWidth)
          const rest = Math.max(0, barWidth - pad - len)
          const n = list.length - shown.length + i + 1
          return (
            <Box flexDirection="column" backgroundColor={run.status === 'running' ? THEME.rowRunning : undefined}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text color={THEME.dim}>{`${n} `}</Text>
                  <Text color={st.fg}>{`${ICON[run.status]} `}</Text>
                  <Text color={typeColor(run.type)} bold>{run.type}</Text>
                  <Text color={THEME.dim}>{`  ${run.description}`}</Text>
                </Text>
                <Text color={st.fg} bold>{` ${elapsed}`}</Text>
              </Box>
              <Text wrap="truncate-end">
                <Text color={THEME.track}>{'─'.repeat(pad)}</Text>
                <Text color={typeColor(run.type)}>{'━'.repeat(len)}</Text>
                <Text color={THEME.track}>{'─'.repeat(rest)}</Text>
                <Text color={THEME.dim}>{meta}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    ))

    const maxMs = Math.max(...types.map(t => t.ms), 1)
    const nameWidth = Math.min(16, Math.max(...types.map(t => t.type.length)) + 1)
    const typeBar = Math.max(6, inner - nameWidth - 14)
    const typeCard = typeRows > 0 && card('By type', 'time spent', (
      <Box flexDirection="column">
        {types.slice(0, 4).map(t => {
          const fill = Math.max(1, Math.round((t.ms / maxMs) * typeBar))
          return (
            <Text wrap="truncate-end">
              <Text color={typeColor(t.type)} bold>{t.type.slice(0, nameWidth - 1).padEnd(nameWidth)}</Text>
              <Text color={typeColor(t.type)}>{'━'.repeat(fill)}</Text>
              <Text color={THEME.track}>{'─'.repeat(typeBar - fill)}</Text>
              <Text color={THEME.title}>{` ${formatDuration(t.ms).padStart(6)}`}</Text>
              <Text color={THEME.dim}>{` ×${t.count}`}</Text>
            </Text>
          )
        })}
      </Box>
    ))

    const graphCard = graphRows > 0 && card('Agent graph', `${count('running')} running`, (
      <Box flexDirection="column">
        <Text>
          <Text color={THEME.main}>● </Text>
          <Text color={THEME.title} bold>main</Text>
        </Text>
        {graph.slice(-6).map(({ run, prefix }) => (
          <Text wrap="truncate-end">
            <Text color={THEME.dim}>{prefix}</Text>
            <Text color={STATUS[run.status].fg}>{`${ICON[run.status]} `}</Text>
            <Text color={typeColor(run.type)}>{run.type}</Text>
            <Text color={THEME.dim}>{run.model ? ` · ${run.model}` : ''}</Text>
          </Text>
        ))}
      </Box>
    ))

    return (
      <Box flexDirection="column">
        {header}
        {live}
        {typeCard}
        {graphCard}
      </Box>
    )
  })
}

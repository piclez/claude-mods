export type AgentRunStatus = 'running' | 'done' | 'failed' | 'stopped'

export type AgentRun = {
  id: string
  type: string
  description: string
  model?: string
  parentId?: string
  isBackground: boolean
  startedAt: number
  endedAt?: number
  status: AgentRunStatus
  toolCount: number
  lastTool?: string
  outputTokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-chart': { runs: AgentRun[]; now: number }
  }
}

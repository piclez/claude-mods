/** One prompt you sent or one final answer Claude gave, cut short. `n` only grows. */
export type Entry = { n: number; role: 'you' | 'claude'; text: string; at: number }

export type TaskStatus = 'active' | 'done' | 'blocked'

export type Task = { id: string; title: string; status: TaskStatus }

/** Haiku's summary. `lastN` is the newest log entry it saw, so an unchanged log skips the call. */
export type Brief = { goal: string; tasks: Task[]; at: number; lastN: number }

export type Category =
  | 'bug_fix'
  | 'feature'
  | 'prod_ops'
  | 'pr_review'
  | 'billing'
  | 'client_writing'
  | 'research'
  | 'other'

export type ModelPick = 'haiku' | 'sonnet' | 'opus' | 'fable'

/** Jev's answers for one task, keyed in `labels` by the task's id. */
export type Label = { category: Category; categoryConf: number | null; model: ModelPick; modelConf: number | null }

/** `hash` is the task titles Jev last labelled, so an unchanged list skips the call. */
export type Labels = { hash: string; byTask: Record<string, Label> }

export type Spend = { haikuIn: number; haikuOut: number; jevIn: number; jevOut: number }

export type RoutingMode = 'off' | 'suggest' | 'auto'

/**
 * The last prompt's routing: Jev's pick (`shown`, Fable included), the model the
 * session was on (`from`), and the one the turn ran on (`to`, equal to `from`
 * when nothing switched). `auto` is false in suggest mode.
 */
export type Route = {
  turnId: string
  from: string
  to: string
  shown: ModelPick
  conf: number | null
  category: Category | null
  reason: string
  auto: boolean
}

/** What the footer says about the last refresh of each half. */
export type Health = { summary: string; jev: string }

declare module 'claude-code' {
  interface PluginState {
    'working-on': {
      log: Shaped<Entry[]>
      brief: Shaped<Brief | null>
      labels: Shaped<Labels>
      spend: Shaped<Spend>
      health: Shaped<Health>
      route: Shaped<Route | null>
      context: Shaped<number>
    }
  }
}

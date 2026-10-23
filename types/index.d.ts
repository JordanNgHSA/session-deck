export type DeckStatus = 'working' | 'permission' | 'question' | 'blocked' | 'finished' | 'idle' | 'done'

// What a session running this mod says about itself, in
// ~/.claude/session-deck/<sessionId>.json: the one thing `claude agents`
// does not say of an interactive session, that it waits on the person.
export type DeckReport = {
  id: string
  // `finished`: a reply the person has not looked at since it ended; it
  // turns `idle` once the session's own tab is the one in front.
  status: 'working' | 'permission' | 'question' | 'finished' | 'idle'
  changedAt: number
  beatAt: number
  // The permission ask the session holds for the deck to answer.
  ask?: DeckAsk
} & DeckHealth

// How a session is faring, as it reports itself: how full its context is,
// what it has cost, and whether it is getting anywhere.
export type DeckHealth = {
  // The live context window's fill, as the status line has it.
  context?: { percent: number; window: number }
  costUsd?: number
  // When a tool call or a turn last began or ended.
  progressAt?: number
  // The main loop's longest-running tool call now under way.
  running?: { tool: string; since: number }
  // One call, the same tool and input, failing this many times in a row.
  failing?: { tool: string; count: number }
}

// A tool call held at its permission ask, its tab's dialog not yet shown,
// until a deck answers it or the person opens its tab.
export type DeckAsk = {
  // The call's tool_use_id: an answer counts for this call alone.
  id: string
  tool: string
  // The call drawn short: the command, or the file with lines added and removed.
  preview: string
  // `danger` takes a second press to allow.
  risk: 'read' | 'write' | 'danger'
  at: number
}

// ~/.claude/session-deck/answers/<sessionId>.json: a deck's answer to that
// session's held ask, read once and removed.
export type DeckAnswer = { askId: string; decision: 'allow' | 'deny'; reason?: string; at: number }

// One row of the pane: a session `claude agents --json` lists, with what the
// report and the transcript add.
export type DeckSession = {
  id: string
  cwd: string
  // The session's first prompt, else the name Claude Code gave it.
  title: string
  status: DeckStatus
  changedAt: number
  isBackground: boolean
  // The background session's id for `claude attach`.
  shortId?: string
  // The terminal tab an interactive session runs in (/dev/ttys003).
  tty?: string
  // One line on what the session is doing now, from a small model.
  summary?: string
  // The model and effort of its latest reply (claude-opus-5-5, medium).
  model?: string
  effort?: string
  // The session's process, which Close all signals to quit.
  pid?: number
  // Its number on the deck, the same in every window and kept while it runs:
  // 1–9 are its hotkeys.
  number?: number
  // Its held permission ask, for the tray.
  ask?: DeckAsk
  // From its fresh report; absent for a session not running this mod.
  health?: DeckHealth
}

// ~/.claude/session-deck/last-closed.json: what Close all ended, for Resume
// all to open again; `resumedAt` once it has.
export type DeckClosed = {
  at: number
  sessions: { id: string; cwd: string; title: string }[]
  resumedAt?: number
  // The end-of-day summary written as they closed.
  digest?: string
  // When they closed, as the Resume button says it ("Thu 5:42 PM").
  label?: string
}

// ~/.claude/session-deck/summaries/<id>.json: the summary, the transcript's
// size it was made from, and when (a pending one claims the work).
export type DeckSummary = { text: string; size: number; at: number }

export type DeckView = { now: number; sessions: DeckSession[]; closed?: DeckClosed }

declare module 'claude-code' {
  interface PluginState {
    'session-deck': {
      view: Shaped<DeckView>
      isConfirming: boolean
      // What Close all is doing now ("" when it is not running).
      closing: string
      isShowingDigest: boolean
      // The ask whose deny reason is being typed ("" when none).
      denying: string
      // The risky ask Allow was pressed on once, awaiting the second press.
      confirmingAsk: string
      // Asks this deck answered, by id, shown as such until their sessions move on.
      sent: Record<string, 'allow' | 'deny'>
    }
  }
}

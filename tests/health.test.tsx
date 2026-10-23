import { mock, test, expect } from 'claude-code/testing'

import type { DeckReport, DeckSession, DeckView } from '../types'

const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const REPORT = `/h/.claude/session-deck/${ME}.json`
const NOW = 1_800_000_000_000

// The engine beneath, enough for session.start; `fails` makes the tool
// calls beneath fail.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], calls: { fails: boolean }) {
  const reports: DeckReport[] = []
  // What the session had reported as each call ran.
  const during: (DeckReport | undefined)[] = []
  on('env.get', (_, e) => ({ value: { HOME: '/h', TERM_PROGRAM: 'Apple_Terminal' }[e.name] }))
  on('session.id', () => ({ value: ME }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    if (e.path === REPORT) reports.push(JSON.parse(e.text))
    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('tool.call', () => {
    during.push(reports.at(-1))
    return (calls.fails ? { result: {}, isError: true, text: 'exit 1' } : { result: {} }) as never
  })
  return Object.assign(reports, { during })
}

const start = { cwd: '/p', surface: 'terminal', isInteractive: true } as const

test('a call under way is reported as running, and its end as progress', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const reports = engine(on, { fails: false })
  await $.session.start(start)

  await clock.advance(5000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  const during = reports.during.at(-1)
  expect(during?.running).toEqual({ tool: 'Bash', since: NOW + 5000 })
  expect(during?.progressAt).toBe(NOW + 5000)
  expect(reports.at(-1)?.running).toBeUndefined()
  expect(reports.at(-1)?.failing).toBeUndefined()
})

test('the same call failing three times in a row is reported, and a success clears it', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = { fails: true }
  const reports = engine(on, calls)
  await $.session.start(start)

  const failing = { tool: 'Bash', command: 'npm run build' } as never
  await $.tool.call(failing)
  await $.tool.call(failing)
  expect(reports.at(-1)?.failing).toBeUndefined()
  await $.tool.call(failing)
  expect(reports.at(-1)?.failing).toEqual({ tool: 'Bash', count: 3 })

  // A different failing call starts a new streak.
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' } as never)
  expect(reports.at(-1)?.failing).toBeUndefined()

  calls.fails = false
  await $.tool.call(failing)
  expect(reports.at(-1)?.failing).toBeUndefined()
})

test("the engine's measure of context and cost is reported", async ($, on) => {
  mock.clock(on, { now: NOW })
  const reports = engine(on, { fails: false })
  await $.session.start(start)

  await $.session.measure({
    context: { tokens: 720_000, window: 1_000_000, percent: 72 },
    rateLimits: [],
    cost: { usd: 3.1 },
    changed: ['context', 'cost'],
  } as never)
  expect(reports.at(-1)?.context).toEqual({ percent: 72, window: 1_000_000 })
  expect(reports.at(-1)?.costUsd).toBe(3.1)
})

// The cards, drawn from a seeded view.
const PANE = {
  plugin: 'session-deck',
  component: 'Pane',
  requestId: 'session-deck',
  surface: 'terminal',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 68,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const card = (n: number, health: DeckSession['health']): DeckSession => ({
  id: `${n}${n}${n}${n}${n}${n}${n}${n}-1111-2222-3333-444444444444`,
  cwd: `/Users/me/app-${n}`,
  title: 'a task',
  status: 'working',
  changedAt: NOW - 600_000,
  isBackground: false,
  health,
})

function seed(on: Parameters<Parameters<typeof test>[1]>[1], sessions: DeckSession[]) {
  const seeded: DeckView = { now: NOW, sessions }
  on('state.get', (_, e, next) =>
    e.key === 'view' ? { value: { value: { shape: 'view-3', value: seeded }, version: 1 } } : next(e),
  )
}

test('a stalled session, a loop and a long call each say so on their card', async ($, on) => {
  seed(on, [
    card(1, { progressAt: NOW - 6 * 60_000 }),
    card(2, { progressAt: NOW - 10_000, failing: { tool: 'Bash', count: 4 } }),
    card(3, { progressAt: NOW - 3 * 60_000, running: { tool: 'Bash', since: NOW - 3 * 60_000 } }),
    card(4, { progressAt: NOW - 10_000 }),
  ])
  const ui = await $.ui.mount(PANE)

  expect((await ui.find({ type: 'Text', text: /no progress/ }))?.text).toBe('⚠ no progress 6m')
  expect((await ui.find({ type: 'Text', text: /failing/ }))?.text).toBe('⚠ Bash failing ×4')
  // A long call is named, not counted as stalled.
  expect((await ui.find({ type: 'Text', text: /^▸/ }))?.text).toBe('▸ Bash 3m')
  expect((await ui.find({ type: 'Text', text: /stalled/ }))?.text).toBe('2 stalled · 4 working')
  await ui.unmount()
})

test('the context bar fills with the window, and the cost shows where it fits', async ($, on) => {
  seed(on, [card(1, { context: { percent: 72, window: 1_000_000 }, costUsd: 3.1, progressAt: NOW })])
  const ui = await $.ui.mount(PANE)
  // Three cards to a row leave 17 columns: the bar, no room for the cost.
  expect((await ui.find({ type: 'Text', text: /^ctx/ }))?.text).toBe('ctx ▓▓▓▓▓▓░░ 72%')
  await ui.unmount()

  // One card to a row leaves 24.
  const wide = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 } })
  expect((await wide.find({ type: 'Text', text: /^ctx/ }))?.text).toBe('ctx ▓▓▓▓▓▓░░ 72% · $3.10')
  await wide.unmount()
})

test('no health line for a session that does not report', async ($, on) => {
  seed(on, [card(1, undefined)])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ctx|no progress|failing/ })).toBeUndefined()
  await ui.unmount()
})

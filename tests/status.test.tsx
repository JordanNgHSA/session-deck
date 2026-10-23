import { mock, test, expect } from 'claude-code/testing'

const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const REPORT = `/h/.claude/session-deck/${ME}.json`

// The engine beneath, enough for session.start: this session is pid 1 on
// /dev/ttys009 in Terminal, and `front` is the tab Terminal has in front.
function engine(
  on: Parameters<Parameters<typeof test>[1]>[1],
  front: { tty: string },
  listed: Record<string, string> = { status: 'idle' },
) {
  const reports: string[] = []
  on('env.get', (_, e) => ({ value: { HOME: '/h', TERM_PROGRAM: 'Apple_Terminal' }[e.name] }))
  on('session.id', () => ({ value: ME }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.write', (_, e) => {
    if (e.path === REPORT) reports.push(JSON.parse(e.text).status)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const [bin, ...args] = e.argv
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (bin === 'claude' && args[0] === 'agents') {
      return out(JSON.stringify([{ pid: 1, cwd: '/p', kind: 'interactive', sessionId: ME, ...listed }]))
    }
    if (bin === '/bin/ps') return out('1 ttys009\n')
    if (bin === '/usr/bin/osascript') return out(front.tty)
    return out('')
  })
  return reports
}

const reply = { answer: 'done', durationMs: 5, turnId: 't1', reason: 'answer' as const }

test('a reply that ends while its tab is not in front waits on the person', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  const reports = engine(on, { tty: '/dev/ttys004' })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  expect(reports.at(-1)).toBe('working')
  await $.turn.complete({ ...reply, isAborted: false })
  expect(reports.at(-1)).toBe('finished')
})

test('a reply that ends in the tab in front, or is interrupted, is idle', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  const front = { tty: '/dev/ttys009' }
  const reports = engine(on, front)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.turn.complete({ ...reply, isAborted: false })
  expect(reports.at(-1)).toBe('idle')

  front.tty = '/dev/ttys004'
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.turn.complete({ ...reply, turnId: 't2', isAborted: true, reason: 'aborted' as never })
  expect(reports.at(-1)).toBe('idle')
})

test('a question waits on the person', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  const reports = engine(on, { tty: '/dev/ttys004' })
  // What the session reported while the question was up.
  const seen: string[] = []
  on('tool.call', () => {
    seen.push(reports.at(-1) ?? '')
    return { result: {} }
  })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(seen).toContain('question')
})

test("Claude Code's own 'waiting for a permission prompt' shows as approve?", async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  engine(on, { tty: '/dev/ttys004' }, { status: 'waiting', waitingFor: 'permission prompt' })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'session-deck',
    component: 'Pane',
    requestId: 'session-deck',
    surface: 'terminal',
    props: {
      title: 'Sessions',
      isFocused: false,
      bodyColumns: 68,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  expect((await ui.find({ type: 'Text', text: /approve\?/ }))?.text).toMatch(/^! approve\? \d+s$/)
  expect((await ui.find({ type: 'Text', text: /needs you/ }))?.text).toBe('1 needs you')
  await ui.unmount()
})

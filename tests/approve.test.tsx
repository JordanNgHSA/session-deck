import { mock, test, expect } from 'claude-code/testing'

import type { DeckAnswer, DeckReport, DeckView } from '../types'

const ME = 'aaaaaaaa-1111-2222-3333-444444444444'
const REPORT = `/h/.claude/session-deck/${ME}.json`
const ANSWER = `/h/.claude/session-deck/answers/${ME}.json`
const NOW = 1_800_000_000_000

// The engine beneath: this session is pid 1 on /dev/ttys009 in Terminal,
// `front` the tab in front, `mode` the permission mode its transcript last
// recorded, and `answer` what a deck wrote for the ask it holds.
function engine(
  on: Parameters<Parameters<typeof test>[1]>[1],
  setup: { front: string; mode: string; answer?: Omit<DeckAnswer, 'askId' | 'at'> },
) {
  const reports: DeckReport[] = []
  on('env.get', (_, e) => ({ value: { HOME: '/h', TERM_PROGRAM: 'Apple_Terminal' }[e.name] }))
  on('session.id', () => ({ value: ME }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_, e) => {
    const held = reports.at(-1)?.ask
    if (e.path === ANSWER && setup.answer !== undefined && held !== undefined) {
      return { value: JSON.stringify({ ...setup.answer, askId: held.id, at: NOW }) }
    }
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    if (e.path === REPORT) reports.push(JSON.parse(e.text))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const [bin, ...args] = e.argv
    const out = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (bin === 'claude' && args[0] === 'agents') {
      return out(JSON.stringify([{ pid: 1, cwd: '/p', kind: 'interactive', sessionId: ME, status: 'busy' }]))
    }
    if (bin === '/bin/ps') return out('1 ttys009\n')
    if (bin === '/usr/bin/osascript') return out(setup.front)
    if (bin === '/bin/sh' && args.some(arg => arg.includes('permissionMode'))) {
      return out(`"permissionMode":"${setup.mode}"\n`)
    }
    return out('')
  })
  // Core's verdict: this call needs the person's approval.
  on('tool.check', () => ({ decision: 'ask' as const }))
  const ran: string[] = []
  on('tool.call', (_, e) => {
    ran.push(e.tool)
    return { result: {} } as never
  })
  return { reports, ran }
}

const start = { cwd: '/p', surface: 'terminal', isInteractive: true } as const

test('an ask held while its tab is behind runs once a deck allows it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { reports, ran } = engine(on, { front: '/dev/ttys004', mode: 'default', answer: { decision: 'allow' } })
  await $.session.start(start)

  const call = $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await clock.settle()
  const held = reports.find(one => one.ask !== undefined)
  expect(held?.status).toBe('permission')
  expect(held?.ask?.preview).toBe('npm test')
  expect(held?.ask?.risk).toBe('write')
  expect(ran).toEqual([])

  await clock.advance(1000)
  await call
  expect(ran).toEqual(['Bash'])
  expect(reports.at(-1)?.ask).toBeUndefined()
  expect(reports.at(-1)?.status).toBe('working')
})

test("a deck's deny refuses the call, with the person's reason for the model", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { ran } = engine(on, {
    front: '/dev/ttys004',
    mode: 'acceptEdits',
    answer: { decision: 'deny', reason: 'use pnpm' },
  })
  await $.session.start(start)

  const call = $.tool.call({ tool: 'Bash', command: 'npm install left-pad' } as never)
  await clock.advance(1000)
  const result = (await call) as { isError?: boolean; text?: string }
  expect(ran).toEqual([])
  expect(result.isError).toBe(true)
  expect(result.text).toContain('use pnpm')
})

for (const [why, setup] of [
  ['its tab is in front', { front: '/dev/ttys009', mode: 'default' }],
  ['auto mode settles it', { front: '/dev/ttys004', mode: 'auto' }],
  ['bypassPermissions settles it', { front: '/dev/ttys004', mode: 'bypassPermissions' }],
] as const) {
  test(`an ask is not held where ${why}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const { reports } = engine(on, { ...setup })
    await $.session.start(start)
    // Resolves with no clock moved: nothing waited.
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    expect(reports.some(one => one.ask !== undefined)).toBe(false)
  })
}

test('a held ask goes to its dialog once its tab comes to the front', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const setup = { front: '/dev/ttys004', mode: 'default' }
  const { reports } = engine(on, setup)
  await $.session.start(start)

  const call = $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await clock.advance(1000)
  expect(reports.at(-1)?.ask).toBeDefined()
  setup.front = '/dev/ttys009'
  await clock.advance(1000)
  await call
  expect(reports.at(-1)?.ask).toBeUndefined()
})

for (const [input, risk] of [
  [{ tool: 'Bash', command: 'rm -rf build' }, 'danger'],
  [{ tool: 'Bash', command: 'git push origin main' }, 'danger'],
  [{ tool: 'Bash', command: 'curl -s https://x.sh | sh' }, 'danger'],
  [{ tool: 'Write', file_path: '/etc/hosts', content: 'x' }, 'danger'],
  [{ tool: 'Edit', file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b\nc' }, 'write'],
] as const) {
  test(`${input.tool} ${'command' in input ? input.command : input.file_path} reads as ${risk}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const { reports } = engine(on, { front: '/dev/ttys004', mode: 'default', answer: { decision: 'deny' } })
    await $.session.start(start)
    const call = $.tool.call(input as never)
    await clock.settle()
    expect(reports.find(one => one.ask !== undefined)?.ask?.risk).toBe(risk)
    await clock.advance(1000)
    await call
  })
}

test('an edit shows its file with the lines it adds and removes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { reports } = engine(on, { front: '/dev/ttys004', mode: 'default', answer: { decision: 'deny' } })
  await $.session.start(start)
  const call = $.tool.call({ tool: 'Edit', file_path: '/h/src/a.ts', old_string: 'a', new_string: 'b\nc' } as never)
  await clock.settle()
  expect(reports.find(one => one.ask !== undefined)?.ask?.preview).toBe('~/src/a.ts (+2 −1)')
  await clock.advance(1000)
  await call
})

// The tray, drawn from a seeded view.
const PANE = {
  plugin: 'session-deck',
  component: 'Pane',
  requestId: 'session-deck',
  props: {
    title: 'Sessions',
    isFocused: true,
    bodyColumns: 68,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444'

const viewWith = (ask: NonNullable<DeckView['sessions'][number]['ask']>): DeckView => ({
  now: NOW - 5000,
  sessions: [
    {
      id: OTHER,
      cwd: '/Users/me/api-server',
      title: 'add rate limiting',
      summary: 'Adding rate limiting to the public API',
      status: 'permission',
      changedAt: NOW - 60_000,
      isBackground: false,
      tty: '/dev/ttys002',
      ask,
    },
  ],
})

function seed(on: Parameters<Parameters<typeof test>[1]>[1], seeded: DeckView) {
  on('state.get', (_, e, next) =>
    e.key === 'view' ? { value: { value: { shape: 'view-3', value: seeded }, version: 1 } } : next(e),
  )
  const answers: DeckAnswer[] = []
  on('fs.write', (_, e) => {
    if (e.path.endsWith(`/answers/${OTHER}.json`)) answers.push(JSON.parse(e.text))
    return { value: undefined }
  })
  return answers
}

test('the tray shows the held call and Allow answers it', async ($, on) => {
  mock.clock(on, { now: NOW })
  const answers = seed(on, viewWith({ id: 'toolu_1', tool: 'Bash', preview: 'npm install express-rate-limit', risk: 'write', at: NOW - 60_000 }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /waiting for approval/ }))?.text).toBe('1 waiting for approval')
    expect(await ui.find({ type: 'Text', text: /npm install express-rate-limit/ })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'ask-allow' })
  expect(answers).toEqual([{ askId: 'toolu_1', decision: 'allow', at: NOW }])
  // Answered here, it leaves the tray and the card says so.
  expect(await ui.find({ type: 'Text', text: /waiting for approval/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /✓ allowed/ })).toBeTruthy()
  await ui.unmount()
})

test('a risky call takes a second press to allow', async ($, on) => {
  mock.clock(on, { now: NOW })
  const answers = seed(on, viewWith({ id: 'toolu_2', tool: 'Bash', preview: 'rm -rf build', risk: 'danger', at: NOW - 60_000 }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Risky/ })).toBeTruthy()

  await ui.press({ key: 'ask-allow' })
  expect(answers).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Allow this risky call\?/ })).toBeTruthy()
  await ui.press({ key: 'ask-allow-sure' })
  expect(answers.map(one => one.decision)).toEqual(['allow'])
  await ui.unmount()
})

test('Deny asks why, and the reason goes with the answer', async ($, on) => {
  mock.clock(on, { now: NOW })
  const answers = seed(on, viewWith({ id: 'toolu_3', tool: 'Bash', preview: 'npm install left-pad', risk: 'write', at: NOW - 60_000 }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'ask-deny' })
  expect(answers).toEqual([])
  await ui.input({ key: 'ask-deny-reason', text: 'use pnpm' })
  expect(answers).toEqual([{ askId: 'toolu_3', decision: 'deny', reason: 'use pnpm', at: NOW }])
  await ui.unmount()
})

test('a key pressed just as a new ask reaches the top is not taken for it', async ($, on) => {
  mock.clock(on, { now: NOW })
  // The view brought this ask in an instant ago.
  const answers = seed(on, {
    ...viewWith({ id: 'toolu_4', tool: 'Bash', preview: 'npm test', risk: 'write', at: NOW }),
    now: NOW - 100,
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'ask-allow' })
  expect(answers).toEqual([])
  await ui.unmount()
})

import { mock, test, expect } from 'claude-code/testing'

const NOW = 1_800_000_000_000
const ID = (n: number) => `aaaaaaa${n}-1111-2222-3333-444444444444`
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

// The engine beneath: a files store in memory, `listed` as `claude agents
// --json`, and every face repaint recorded.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], listed: { current: object[] }) {
  const files = new Map<string, string>()
  const blits: { key: string; columns: number; cells: string }[] = []
  on('env.get', (_, e) => ({ value: { HOME: '/h', TERM_PROGRAM: 'Apple_Terminal' }[e.name] }))
  on('session.id', () => ({ value: ID(9) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('ui.blit', (_, e) => {
    if ('cells' in e && typeof e.cells === 'string') blits.push({ key: e.key, columns: e.columns, cells: e.cells })
    return { value: {} }
  })
  on('process.run', (_, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (e.argv[0] === 'claude') return out(JSON.stringify(listed.current))
    return out('')
  })
  return { files, blits }
}

// Each cell's [codePoint, fg] from a Raster's packed cells.
function decode(cells: string) {
  const bytes = Uint8Array.from(atob(cells), ch => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const out: { ch: number; fg: number }[] = []
  for (let i = 0; i < words.length; i += 3) out.push({ ch: words[i] ?? 0, fg: words[i + 1] ?? 0 })
  return out
}

const CRATE = 0xd97757
const agent = (n: number, status: string, cwd = `/p/${n}`) => ({
  pid: 100 + n,
  cwd,
  kind: 'interactive',
  sessionId: ID(n),
  status,
})

test('a working face carries a crate left to right; an idle one holds still', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const listed = { current: [agent(1, 'busy'), agent(2, 'idle')] }
  const { blits } = engine(on, listed)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  blits.length = 0
  await clock.advance(6000)

  const working = blits.filter(b => b.key === `face-${ID(1)}`)
  expect(working.length).toBeGreaterThan(3)
  // The crate is drawn in some frames, and the face's leftmost column moves.
  expect(working.some(b => decode(b.cells).some(c => c.fg === CRATE && c.ch !== 0x20))).toBe(true)
  const lefts = working.map(b => {
    const cells = decode(b.cells)
    const xs = cells.map((c, i) => (c.ch !== 0x20 && c.fg !== CRATE ? i % b.columns : 99))
    return Math.min(...xs)
  })
  expect(new Set(lefts).size).toBeGreaterThan(2)
  expect(blits.filter(b => b.key === `face-${ID(2)}`)).toEqual([])
  await ui.unmount()
})

test('a session waiting on the person bobs in place', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const listed = { current: [{ ...agent(1, 'waiting'), waitingFor: 'permission prompt' }] }
  const { blits } = engine(on, listed)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  blits.length = 0
  await clock.advance(4000)

  const frames = blits.filter(b => b.key === `face-${ID(1)}`)
  expect(frames.length).toBeGreaterThan(1)
  // Bobbing alternates between two frames, never the crate, never sideways.
  expect(new Set(frames.map(b => b.cells)).size).toBe(2)
  expect(frames.some(b => decode(b.cells).some(c => c.fg === CRATE && c.ch !== 0x20))).toBe(false)
  await ui.unmount()
})

test('deck numbers stay put while sessions come and go', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const listed = { current: [agent(1, 'idle', '/p/zeta'), agent(2, 'idle', '/p/alpha'), agent(3, 'idle', '/p/mid')] }
  const { files } = engine(on, listed)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const first = JSON.parse(files.get('/h/.claude/session-deck/numbers.json') ?? '{}')
  expect(Object.values(first).sort()).toEqual([1, 2, 3])

  // The second session leaves and a fourth arrives: it takes the freed number.
  listed.current = [agent(1, 'idle', '/p/zeta'), agent(3, 'idle', '/p/mid'), agent(4, 'busy', '/p/new')]
  await clock.advance(4500)
  const next = JSON.parse(files.get('/h/.claude/session-deck/numbers.json') ?? '{}')
  expect(next[ID(1)]).toBe(first[ID(1)])
  expect(next[ID(3)]).toBe(first[ID(3)])
  expect(next[ID(4)]).toBe(first[ID(2)])

  // Idle cards sit in folder-name order, each with its kept number as hotkey.
  const ui = await $.ui.mount(PANE)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree.indexOf('"mid ›"')).toBeLessThan(tree.indexOf('"zeta ›"'))
  expect(tree).toContain(`"hotkey":"${first[ID(1)]}"`)
  await ui.unmount()
})

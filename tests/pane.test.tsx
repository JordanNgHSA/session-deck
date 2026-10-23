import { expect, mock, test } from 'claude-code/testing'

import type { DeckView } from '../types'

const PANE = {
  plugin: 'session-deck',
  component: 'Pane',
  requestId: 'session-deck',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = 1_800_000_000_000

const VIEW: DeckView = {
  now: NOW,
  sessions: [
    {
      id: '11111111-2222-4333-8444-555555555555',
      cwd: '/Users/me/docs-site',
      title: 'set up the commenting system',
      summary: 'Migrating the temporary comment server to the new host',
      model: 'claude-opus-5-5',
      effort: 'medium',
      status: 'working',
      changedAt: NOW - 90_000,
      isBackground: false,
      tty: '/dev/ttys001',
    },
    {
      id: '22222222-3333-4444-8555-666666666666',
      cwd: '/Users/me/acme-storefront',
      title: 'This is the storefront repository for my site',
      status: 'blocked',
      changedAt: NOW - 5_000,
      isBackground: true,
      shortId: '22222222',
    },
  ],
}

test('each session is a card with its face, status and summary', async ($, on) => {
  on('state.get', (_, e, next) =>
    e.key === 'view' ? { value: { value: { shape: 'view-3', value: VIEW }, version: 1 } } : next(e),
  )

  for (const [surface, bodyColumns] of [
    ['terminal', 68],
    ['desktop', 60],
  ] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns } })

    // The tally leads with what needs the person.
    expect((await ui.find({ type: 'Text', text: /needs you · / }))?.text).toBe('1 needs you · 1 working')
    expect(await ui.find({ type: 'Text', text: /Migrating\s+the\s+temporary\s+comment/ })).toBeTruthy()
    // No summary yet: the first prompt stands in.
    expect(await ui.find({ type: 'Text', text: /This\s+is\s+the\s+storefront\s+repository/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /needs you/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /docs-site/ })).toBeTruthy()
    if (surface === 'desktop') {
      expect((await ui.find({ type: 'Text', text: /SESSION DECK/ }))?.text).toBe('SESSION DECK')
    }
    expect((await ui.find({ type: 'Text', text: /Opus/ }))?.text).toBe(
      bodyColumns >= 68 ? 'Opus 5.5 · medium' : 'Opus 5.5 · med',
    )
    await ui.unmount()
  }
})

test('Close all asks first, and only Yes stops the sessions', async ($, on) => {
  const VIEW_WITH_PIDS: DeckView = {
    ...VIEW,
    sessions: VIEW.sessions.map(one => (one.isBackground ? one : { ...one, pid: 4242 })),
  }
  // The view is seeded; isConfirming goes to the kit's own store beneath.
  on('state.get', (_, e, next) =>
    e.key === 'view' ? { value: { value: { shape: 'view-3', value: VIEW_WITH_PIDS }, version: 1 } } : next(e),
  )
  const clock = mock.clock(on, { now: NOW })
  const ran: string[][] = []
  const wrote: string[] = []
  // Writes and runs in the order they happened.
  const order: string[] = []
  const texts = new Map<string, string>()
  on(
    'model.complete',
    () =>
      ({
        value: {
          isAnswered: true,
          text: '**Done**\n- Moved the comment server to the new host\n**Left to do**\n- Nothing obvious',
        },
      }) as never,
  )
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    order.push(e.argv.join(' '))
    // Today's conversation, after the stand-in midnight below.
    const transcript = [
      { type: 'user', timestamp: '2027-01-15T10:00:00Z', message: { content: 'move the comment server' } },
      {
        type: 'assistant',
        timestamp: '2027-01-15T10:04:00Z',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/resources.php' } }] },
      },
      { type: 'assistant', timestamp: '2027-01-15T10:05:00Z', message: { content: 'Moved it to VIP.' } },
      { type: 'system', subtype: 'turn_duration', durationMs: 600_000, timestamp: '2027-01-15T10:05:01Z' },
      // Yesterday's work is left out of today's totals.
      { type: 'system', subtype: 'turn_duration', durationMs: 9_000_000, timestamp: '2027-01-14T09:00:00Z' },
    ]
      .map(row => JSON.stringify(row))
      .join('\n')
    // grep over the transcript, as the summary searches it: a plain word,
    // or -noE with each match's line number.
    if (e.argv[0] === '/usr/bin/grep') {
      const lines = transcript.split('\n')
      const [flag = '', pattern = ''] = e.argv.slice(1, -1)
      const hits =
        flag === '-noE'
          ? lines.flatMap((line, i) =>
              [...line.matchAll(new RegExp(pattern, 'g'))].map(m => `${i + 1}:${m[0]}`),
            )
          : lines.filter(line => line.includes(flag))
      return { value: { exitCode: hits.length > 0 ? 0 : 1, stdout: hits.join('\n'), stderr: '' } }
    }
    const git = e.argv[0] === 'git' ? e.argv[3] : undefined
    const stdout =
      git === 'rev-parse'
        ? 'prod-abc-123-resource-urls\n'
        : git === 'log'
          ? "ABC-123: point theme URLs at the theme's resources folder\n"
          : git === 'status'
            ? ' M functions.php\n?? inc/new.php\n'
            : e.argv[0] === '/usr/bin/tail'
              ? transcript
              : e.argv[0] === '/bin/date'
                ? e.argv.includes('-v0H')
                  ? '1799990000\n'
                  : '2026-10-22|Thursday, October 22, 2026|5:42 PM\n'
                : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('fs.write', (_, e) => {
    wrote.push(e.path)
    order.push(`write ${e.path}`)
    texts.set(e.path, e.text)
    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'close-all' })
  expect(await ui.find({ type: 'Text', text: /Close all 2 sessions/ })).toBeTruthy()
  // Only the working session is mid-reply; the blocked one is counted apart.
  expect((await ui.find({ type: 'Text', text: /mid-reply/ }))?.text).toBe(
    '1 is mid-reply and will be cut off.',
  )
  expect((await ui.find({ type: 'Text', text: /waiting on an/ }))?.text).toBe(
    '1 is waiting on an approval or answer.',
  )
  expect(ran).toEqual([])

  await ui.press({ key: 'close-all-cancel' })
  expect(await ui.find({ type: 'Text', text: /Close all 2 sessions/ })).toBeUndefined()
  expect(ran).toEqual([])

  await ui.press({ key: 'close-all' })
  await ui.press({ key: 'close-all-yes' })
  // The saved path shows first; nothing has closed yet.
  expect((await ui.find({ type: 'Text', text: /^Saved / }))?.text).toMatch(
    /session-deck-logs\/2026-10-22\.md · closing sessions…$/,
  )
  expect(ran.some(argv => argv[0] === '/bin/kill' || argv[1] === 'stop')).toBe(false)
  await clock.advance(3000)
  expect(wrote.some(path => path.endsWith('last-closed.json'))).toBe(true)
  expect(ran).toContainEqual(['claude', 'stop', '22222222'])
  expect(ran).toContainEqual(['/bin/kill', '-TERM', '4242'])

  // The summary is written first, with each session's recap in it.
  const digest = [...texts.keys()].find(path => path.endsWith('/session-deck-logs/2026-10-22.md'))
  expect(digest).toBeTruthy()
  const text = texts.get(digest ?? '') ?? ''
  expect(text).toContain('# Session Deck: Thursday, October 22, 2026')
  expect(text).toContain('## Closed at 5:42 PM · 2 sessions')
  expect(text).toContain('### docs-site · Opus 5.5 · medium')
  expect(text).toContain('- Moved the comment server to the new host')
  // The day at a glance: 2 sessions × 10 active minutes, one commit per repo,
  // the one file both edited, the ticket from branch and commit, unsaved work.
  expect(text).toContain('**At a glance:** 2 sessions · 20m active · 2 commits · 1 file edited')
  expect(text).toContain('**Tickets:** ABC-123')
  expect(text).toContain('**⚠ Uncommitted:** acme-storefront (2 files), docs-site (2 files)')
  expect(text).toContain(
    'Active 10m across 1 reply · 10:00 AM – 10:05 AM · `prod-abc-123-resource-urls` · 1 commit · ⚠ 2 files uncommitted',
  )
  expect(order.indexOf(`write ${digest}`)).toBeLessThan(order.findIndex(step => step.startsWith('/bin/kill')))
  expect(order.indexOf(`write ${digest}`)).toBeLessThan(
    order.findIndex(step => step.startsWith('claude stop')),
  )
  await ui.unmount()
})

test('Resume opens the closed sessions as tabs, and says how to allow tabs when it can only make windows', async ($, on) => {
  const closed = {
    at: NOW - 3_600_000,
    label: 'Wed 5:42 PM',
    sessions: [
      { id: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: '/Users/me/one', title: 'one' },
      { id: 'bbbbbbbb-1111-2222-3333-444444444444', cwd: '/Users/me/two', title: 'two' },
    ],
  }
  on('state.get', (_, e, next) =>
    e.key === 'view'
      ? { value: { value: { shape: 'view-3', value: { now: NOW, sessions: [], closed } }, version: 1 } }
      : next(e),
  )
  mock.clock(on, { now: NOW })
  // What osascript answers: "ok" made tabs, "windows" fell back to windows.
  const answer = { current: 'ok' }
  const scripts: string[][] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === '/usr/bin/osascript') scripts.push([...e.argv])
    return {
      value: { exitCode: 0, stdout: e.argv[0] === '/usr/bin/osascript' ? answer.current : '', stderr: '' },
    }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })

  // A session start in Terminal, so the pane knows which app to script.
  on('env.get', (_, e) => ({ value: { HOME: '/Users/me', TERM_PROGRAM: 'Apple_Terminal' }[e.name] }))
  on('session.id', () => ({ value: 'cccccccc-1111-2222-3333-444444444444' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', () => ({ value: [] }))
  await $.session.start({ cwd: '/Users/me', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'resume-all' })
  // Both sessions go to one script run, each as its own resume command.
  expect(scripts.length).toBe(1)
  expect(scripts[0]?.slice(-2)).toEqual([
    "cd '/Users/me/one' && claude --resume aaaaaaaa-1111-2222-3333-444444444444",
    "cd '/Users/me/two' && claude --resume bbbbbbbb-1111-2222-3333-444444444444",
  ])
  expect(toasts).toEqual([])

  answer.current = 'windows'
  await ui.press({ key: 'resume-all' })
  expect(toasts.at(-1)).toContain('Privacy & Security › Accessibility')
  await ui.unmount()
})

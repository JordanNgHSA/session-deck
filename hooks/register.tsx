import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  DeckAnswer,
  DeckAsk,
  DeckClosed,
  DeckHealth,
  DeckReport,
  DeckSession,
  DeckStatus,
  DeckSummary,
  DeckView,
} from '../types'

// The list is Claude Code's own: `claude agents --json` names every running
// session, interactive and background, idle or busy. A session that runs this
// mod also reports, in ~/.claude/session-deck/<id>.json, when it waits on the
// person, which the list does not say of an interactive session.
const PANE = 'session-deck'
const TICK_MS = 4000
const STALE_MS = 20000
const PRUNE_MS = 24 * 60 * 60 * 1000

// A summary is redone once the transcript grew this much since the last, and
// no sooner than RESUMMARY_MS; a pending one older than PENDING_MS is retried.
const GROWTH_BYTES = 40000
const RESUMMARY_MS = 10 * 60 * 1000
const PENDING_MS = 2 * 60 * 1000
// Three cards to a row: the dock is asked for room for three of about 21
// columns, and a narrower pane falls back to two or one.
const PER_ROW = 3
const MIN_CARD = 15
const PANE_COLUMNS = 68
// Space kept clear inside the pane's frame: columns each side, rows above and below.
const PAD_X = 1
const PAD_Y = 1
// Blank rows above and below a card's face, and the card's height: border,
// face with its padding, name, status, model and up to five lines of summary.
// A face's stage: three rows, two pixel rows to a cell, so a 5-pixel face
// with a pixel of headroom to hop into.
const FACE_ROWS = 3
const FRAME_MS = 150
// The current session's badge: bright cyan, bold, as a filled chip.
const THIS_COLOR = '#22e4ff'
// A card's summary: at most this many lines.
const SUMMARY_LINES = 3
// Resume is offered for this long after Close all.
const RESUME_MS = 36 * 60 * 60 * 1000
// Past this many sessions the big title gives its rows to the cards.
const BIG_TITLE_MAX = 3
// A held permission ask: how often it looks for an answer or its tab in
// front, and how long it waits before its tab's dialog takes it.
const POLL_MS = 1000
const HOLD_MS = 5 * 60 * 1000
// A key pressed this soon after another ask took the tray's top is not taken
// for it: it was likely meant for the one before.
const LOCK_MS = 600
// The modes whose asks go to a dialog; under any other (auto, dontAsk,
// bypassPermissions) an ask is the mode's to settle, and is not held.
const HOLDABLE_MODES = new Set(['default', 'acceptEdits', 'plan'])
// A working session with no tool under way and no tool call or turn begun
// or ended in STALL_MS is stalled; a tool running past LONG_TOOL_MS is named.
const STALL_MS = 5 * 60 * 1000
const LONG_TOOL_MS = 2 * 60 * 1000
// The same call failing this many times in a row is a loop.
const LOOP_COUNT = 3
// Context fill, as a percentage: amber from CONTEXT_WARN, red from CONTEXT_FULL.
const CONTEXT_WARN = 70
const CONTEXT_FULL = 90

const view = atom({ plugin: 'session-deck', key: 'view' } as const, { now: 0, sessions: [] } as DeckView, {
  shape: 'view-3',
})

// Whether the pane is asking to confirm Close all.
const isConfirming = atom({ plugin: 'session-deck', key: 'isConfirming' } as const, false)
const closing = atom({ plugin: 'session-deck', key: 'closing' } as const, '')
const isShowingDigest = atom({ plugin: 'session-deck', key: 'isShowingDigest' } as const, false)
const denying = atom({ plugin: 'session-deck', key: 'denying' } as const, '')
const confirmingAsk = atom({ plugin: 'session-deck', key: 'confirmingAsk' } as const, '')
const sent = atom({ plugin: 'session-deck', key: 'sent' } as const, {} as Record<string, 'allow' | 'deny'>)

// One entry of `claude agents --json`.
type Agent = {
  pid?: number
  id?: string
  cwd?: string
  kind?: string
  sessionId?: string
  name?: string
  // idle | busy | waiting; with waiting, what for ("permission prompt").
  status?: string
  waitingFor?: string
  state?: string
}

let me: DeckReport | undefined
// This session's own folder, for its transcript.
let cwd = ''
let dir = ''
let home = ''
let app = ''
// First prompts by session id; a session with none yet is asked again.
const titles = new Map<string, string>()
// This session's main-loop tool calls under way, by call, and the last
// failed call, for its streak.
const inFlight = new Map<number, { tool: string; since: number }>()
let calls = 0
let lastFail = { key: '', tool: '', count: 0 }
// The ask at the top of the tray and when it got there, for LOCK_MS.
let top = { id: '', at: 0 }
// The person turned the faces' motion off (/sessions-motion), kept across sessions.
let isStill = false

async function report($: EngineInterface, status?: DeckReport['status']) {
  if (me === undefined) return
  const now = await $.clock.now()
  const isChange = status !== undefined && status !== me.status
  me = { ...me, status: status ?? me.status, beatAt: now, changedAt: isChange ? now : me.changedAt }
  await $.fs.write(`${dir}/${me.id}.json`, JSON.stringify(me))
}

// Changes what this session reports of itself, its status left as it is.
async function note($: EngineInterface, patch: Partial<DeckReport>) {
  if (me === undefined) return
  me = { ...me, ...patch }
  await report($)
}

// The longest-running main-loop call under way, if any.
const oldestRunning = () => [...inFlight.values()].sort((a, b) => a.since - b.since)[0]

// A call's identity for its failure streak: the tool and its input.
const callKey = (e: object) => {
  const { agentId: _agent, requestMeta: _meta, tool_use_id: _id, ...call } = e as Record<string, unknown>
  return JSON.stringify(call)
}

async function setStatus($: EngineInterface, status: DeckReport['status']) {
  await report($, status)
  await refresh($)
}

async function agents($: EngineInterface) {
  const ran = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 15000 }).catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) return undefined
  try {
    const list = JSON.parse(ran.stdout) as Agent[]
    return Array.isArray(list) ? list : undefined
  } catch {
    return undefined
  }
}

// The terminal of each interactive session's process.
async function ttys($: EngineInterface, list: Agent[]) {
  const pids = list.filter(a => a.kind !== 'background' && a.pid).map(a => String(a.pid))
  const found = new Map<number, string>()
  if (pids.length === 0) return found
  const ran = await $.process.run(['/bin/ps', '-o', 'pid=,tty=', '-p', pids.join(',')]).catch(() => undefined)
  for (const line of ran?.stdout.split('\n') ?? []) {
    const [pid, tty] = line.trim().split(/\s+/)
    if (pid && tty?.startsWith('ttys')) found.set(Number(pid), `/dev/${tty}`)
  }
  return found
}

const transcriptOf = (a: { cwd?: string; sessionId?: string }) =>
  `${home}/.claude/projects/${(a.cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-')}/${a.sessionId}.jsonl`

// The person's and the model's words in a stretch of transcript, oldest
// first; tool calls, results and injected notes left out.
// With `since`, only what was said from then on.
function linesOf(raw: string, since?: number) {
  const said: { role: 'user' | 'assistant'; text: string }[] = []
  for (const line of raw.split('\n')) {
    let row: { type?: string; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta) continue
    if (since !== undefined && !(Date.parse(row.timestamp ?? '') >= since)) continue
    const content = row.message?.content
    const text = (
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map(block => (block?.type === 'text' ? String(block.text) : '')).join(' ')
          : ''
    )
      .trim()
      .replace(/\s+/g, ' ')
    if (text === '' || text.startsWith('<')) continue
    said.push({ role: row.type, text })
  }
  return said
}

// The first prompt the person typed, from the head of the transcript.
async function titleOf($: EngineInterface, a: Agent) {
  const id = a.sessionId ?? ''
  const known = titles.get(id)
  if (known) return known
  const ran = await $.process.run(['/usr/bin/head', '-c', '300000', transcriptOf(a)]).catch(() => undefined)
  const first = linesOf(ran?.stdout ?? '').find(one => one.role === 'user')
  if (first === undefined) return ''
  titles.set(id, first.text.slice(0, 200))
  return first.text.slice(0, 200)
}

// The model and effort the latest reply ran with, read from the end of the
// transcript; read again only when the transcript has grown.
const engines = new Map<string, { size: number; model?: string; effort?: string }>()

async function engineOf($: EngineInterface, a: Agent, size: number) {
  const id = a.sessionId ?? ''
  const known = engines.get(id)
  if (known !== undefined && known.size === size) return known
  const tail = await $.process.run(['/usr/bin/tail', '-c', '60000', transcriptOf(a)]).catch(() => undefined)
  const found: { size: number; model?: string; effort?: string } = { size, ...known }
  for (const line of (tail?.stdout ?? '').split('\n').reverse()) {
    let row: { type?: string; effort?: string; message?: { model?: string } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const model = row.message?.model
    if (row.type !== 'assistant' || !model || model.startsWith('<')) continue
    found.model = model
    found.effort = row.effort ?? found.effort
    break
  }
  engines.set(id, found)
  return found
}

// claude-opus-5-5 → Opus 5.5; anything else as it is.
function modelName(model: string) {
  const parts = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model)
  if (parts === null) return model
  const [, family = '', major, minor] = parts
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

// "Opus 5.5 · medium", or "Opus 5.5 · med" where the card is too narrow.
function engineLine(model: string, effort: string | undefined, width: number) {
  const full = [modelName(model), effort].filter(Boolean).join(' · ')
  if (full.length <= width || effort !== 'medium') return cut(full, width)
  return cut(`${modelName(model)} · med`, width)
}

const summaryFile = (id: string) => `${dir}/summaries/${id}.json`

async function summaryOf($: EngineInterface, id: string) {
  return $.fs
    .read(summaryFile(id))
    .then(text => JSON.parse(text) as DeckSummary)
    .catch(() => undefined)
}

const summarizing = new Set<string>()

// Asks a small model what the session is doing now, from its first prompt and
// the latest stretch of its transcript. The pending file claims the work, so
// the other sessions' panes wait for this one's answer.
async function summarize($: EngineInterface, a: Agent, title: string, size: number, had?: DeckSummary) {
  const id = a.sessionId ?? ''
  if (summarizing.has(id)) return
  summarizing.add(id)
  try {
    const now = await $.clock.now()
    await $.fs.write(
      summaryFile(id),
      JSON.stringify({ text: had?.text ?? '', size: had?.size ?? -1, at: now }),
    )
    const tail = await $.process
      .run(['/usr/bin/tail', '-c', '120000', transcriptOf(a)])
      .catch(() => undefined)
    const recent = linesOf(tail?.stdout ?? '')
      .map(one => `${one.role === 'user' ? 'Person' : 'Claude'}: ${one.text.slice(0, 600)}`)
      .join('\n')
      .slice(-6000)
    if (title === '' && recent === '') return
    const answer = await $.model.complete({
      model: 'haiku',
      maxTokens: 60,
      timeoutMs: 30000,
      system:
        'You label Claude Code sessions for a dashboard. Answer with one plain line of at most 12 words saying what the session is working on now. No quotes, no preamble, no trailing period.',
      prompt: `Project folder: ${a.cwd}\nFirst request: ${title.slice(0, 1500)}\n\nLatest conversation:\n${recent}`,
    })
    if (!answer.isAnswered) return
    const text =
      answer.text
        .trim()
        .split('\n')[0]
        ?.replace(/^["']|["'.]$/g, '') ?? ''
    if (text !== '') {
      await $.fs.write(summaryFile(id), JSON.stringify({ text, size, at: await $.clock.now() }))
    }
  } finally {
    summarizing.delete(id)
  }
}

function needsSummary(had: DeckSummary | undefined, size: number, now: number) {
  if (size <= 0) return false
  if (had === undefined) return true
  const isPending = had.size < 0 || had.text === ''
  if (isPending) return now - had.at > PENDING_MS
  return size - had.size > GROWTH_BYTES && now - had.at > RESUMMARY_MS
}

// Each transcript's size in bytes, by path.
async function sizes($: EngineInterface, paths: string[]) {
  const found = new Map<string, number>()
  if (paths.length === 0) return found
  const ran = await $.process.run(['/usr/bin/stat', '-f', '%z %N', ...paths]).catch(() => undefined)
  for (const line of ran?.stdout.split('\n') ?? []) {
    const space = line.indexOf(' ')
    if (space > 0) found.set(line.slice(space + 1), Number(line.slice(0, space)))
  }
  return found
}

async function reportOf($: EngineInterface, id: string) {
  return $.fs
    .read(`${dir}/${id}.json`)
    .then(text => JSON.parse(text) as DeckReport)
    .catch(() => undefined)
}

function statusOf(a: Agent, mine: DeckReport | undefined, now: number): DeckStatus {
  // Claude Code's own word that the session waits on the person comes first:
  // the session's hooks may be passed over by a plugin above them.
  if (a.status === 'waiting') {
    const what = (a.waitingFor ?? '').toLowerCase()
    return what.includes('permission') ? 'permission' : what.includes('question') ? 'question' : 'blocked'
  }
  const isFresh = mine !== undefined && now - mine.beatAt < STALE_MS
  if (isFresh && (mine.status === 'permission' || mine.status === 'question')) return mine.status
  // A new turn under way outranks a reply still unseen.
  if (isFresh && mine.status === 'finished' && a.status !== 'busy') return 'finished'
  if (a.state === 'blocked') return 'blocked'
  if (a.state === 'done') return 'done'
  return a.status === 'busy' ? 'working' : 'idle'
}

async function refresh($: EngineInterface) {
  const list = await agents($)
  if (list === undefined) return
  const now = await $.clock.now()
  const terminals = await ttys($, list)
  const sized = await sizes($, list.filter(a => a.sessionId && a.cwd).map(transcriptOf))
  const rows: Omit<DeckSession, 'changedAt'>[] = []
  for (const a of list) {
    if (!a.sessionId || !a.cwd) continue
    const first = await titleOf($, a)
    const size = sized.get(transcriptOf(a)) ?? 0
    const had = await summaryOf($, a.sessionId)
    const engine = await engineOf($, a, size)
    if (needsSummary(had, size, now)) void summarize($, a, first, size, had).catch(() => {})
    const mine = await reportOf($, a.sessionId)
    const isFresh = mine !== undefined && now - mine.beatAt < STALE_MS
    rows.push({
      id: a.sessionId,
      cwd: a.cwd,
      title: first || (a.name ?? ''),
      status: statusOf(a, mine, now),
      ask: isFresh && mine.status === 'permission' ? mine.ask : undefined,
      health: isFresh
        ? {
            context: mine.context,
            costUsd: mine.costUsd,
            progressAt: mine.progressAt,
            running: mine.running,
            failing: mine.failing,
          }
        : undefined,
      isBackground: a.kind === 'background',
      shortId: a.id,
      tty: a.pid === undefined ? undefined : terminals.get(a.pid),
      pid: a.pid,
      summary: had?.text || undefined,
      model: engine.model,
      effort: engine.effort,
    })
  }
  const closed = await $.fs
    .read(closedFile())
    .then(text => JSON.parse(text) as DeckClosed)
    .catch(() => undefined)
  const numbers = await numbersFor(
    $,
    rows.map(row => row.id),
  )
  // A status keeps the time it began across refreshes.
  await update($, view, before => ({
    now,
    closed,
    sessions: rows.map(row => {
      const was = before.sessions.find(one => one.id === row.id && one.status === row.status)
      return { ...row, changedAt: was?.changedAt ?? now, number: numbers[row.id] }
    }),
  }))
}

// Each running session's deck number, shared by every window through
// ~/.claude/session-deck/numbers.json: a session keeps its number while it
// runs; a new one takes the lowest free number.
async function numbersFor($: EngineInterface, ids: string[]) {
  const path = `${dir}/numbers.json`
  const had = await $.fs
    .read(path)
    .then(text => JSON.parse(String(text)) as Record<string, number>)
    .catch(() => ({}) as Record<string, number>)
  const kept: Record<string, number> = {}
  for (const id of ids) if (typeof had[id] === 'number') kept[id] = had[id]
  const taken = new Set(Object.values(kept))
  let free = 1
  for (const id of ids) {
    if (kept[id] !== undefined) continue
    while (taken.has(free)) free++
    kept[id] = free
    taken.add(free)
  }
  if (JSON.stringify(kept) !== JSON.stringify(had))
    await $.fs.write(path, JSON.stringify(kept)).catch(() => {})
  return kept
}

// Reports of sessions long gone (closed without a session.end).
async function prune($: EngineInterface) {
  const now = await $.clock.now()
  for (const folder of [dir, `${dir}/summaries`]) {
    for (const entry of await $.fs.list(folder).catch(() => [])) {
      if (entry.kind === 'file' && now - entry.mtimeMs > PRUNE_MS) {
        await $.process.run(['rm', '-f', `${folder}/${entry.name}`]).catch(() => {})
      }
    }
  }
}

// Blue is the person's move, in two tiers. Blocked (an approval, a question,
// a background run that cannot go on): thick border, bold, first in the grid,
// longest wait first. Replied (a reply not looked at yet): the same blue,
// thin border, after the blocked ones.
const WAIT_COLOR = '#4da3ff'
const isBlocked = (status: DeckStatus) => RANK[status] === 0

const RANK: Record<DeckStatus, number> = {
  permission: 0,
  question: 0,
  blocked: 0,
  finished: 1,
  working: 2,
  idle: 3,
  done: 4,
}

const LOOK: Record<DeckStatus, { glyph: string; label: string; color: string }> = {
  permission: { glyph: '!', label: 'approve?', color: WAIT_COLOR },
  question: { glyph: '?', label: 'question', color: WAIT_COLOR },
  blocked: { glyph: '■', label: 'needs you', color: WAIT_COLOR },
  finished: { glyph: '↩', label: 'replied', color: WAIT_COLOR },
  working: { glyph: '●', label: 'working', color: 'claude' },
  idle: { glyph: '○', label: 'idle', color: 'subtle' },
  done: { glyph: '✓', label: 'done', color: 'success' },
}

// The project's folder name; the home folder as ~.
const projectName = (cwd: string) => (cwd === home ? '~' : (cwd.split('/').filter(Boolean).at(-1) ?? cwd))

// Sessions waiting on the person (blocked, then replied) longest-waiting
// first; working and idle ones by folder name, so a card holds its place
// while the person looks away.
const byUrgency = (a: DeckSession, b: DeckSession) =>
  RANK[a.status] - RANK[b.status] ||
  (RANK[a.status] <= RANK.finished
    ? a.changedAt - b.changedAt
    : projectName(a.cwd).localeCompare(projectName(b.cwd)) || (a.number ?? 99) - (b.number ?? 99))

// What a working session's card warns of, worst first: one call failing
// again and again, no progress at all, or a call that has run a while.
function alertOf(one: DeckSession, now: number): { text: string; color: string; isStuck: boolean } | undefined {
  const health = one.health
  if (health === undefined || one.status !== 'working') return undefined
  if (health.failing !== undefined) {
    return { text: `⚠ ${health.failing.tool} failing ×${health.failing.count}`, color: 'error', isStuck: true }
  }
  if (health.running !== undefined) {
    const ran = now - health.running.since
    return ran >= LONG_TOOL_MS ? { text: `▸ ${health.running.tool} ${ago(ran)}`, color: 'subtle', isStuck: false } : undefined
  }
  if (health.progressAt !== undefined && now - health.progressAt >= STALL_MS) {
    return { text: `⚠ no progress ${ago(now - health.progressAt)}`, color: 'warning', isStuck: true }
  }
  return undefined
}

// The context window's fill as a bar, and the cost where the card has room:
// "ctx ▓▓▓░░░ 42% · $3.10".
function contextLine(health: DeckHealth, width: number) {
  if (health.context === undefined) return undefined
  const percent = Math.max(0, Math.min(100, Math.round(health.context.percent)))
  const label = ` ${percent}%`
  const cells = Math.max(3, Math.min(8, width - 4 - label.length))
  const filled = Math.round((cells * percent) / 100)
  const bar = `ctx ${'▓'.repeat(filled)}${'░'.repeat(cells - filled)}${label}`
  const cost = health.costUsd === undefined ? '' : ` · $${health.costUsd.toFixed(2)}`
  return {
    text: bar.length + cost.length <= width ? bar + cost : bar,
    color: percent >= CONTEXT_FULL ? 'error' : percent >= CONTEXT_WARN ? 'warning' : undefined,
  }
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

const cut = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`

// Word-wraps text to `width` and keeps the first `lines` lines, the last
// one ending "…" when there was more.
function clamp(text: string, width: number, lines: number) {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line === '' ? word : `${line} ${word}`
    if (next.length <= width) {
      line = next
      continue
    }
    if (line !== '') out.push(line)
    line = word.length > width ? cut(word, width) : word
    if (out.length === lines) break
  }
  if (line !== '' && out.length < lines) out.push(line)
  const isCut = out.join(' ').length < text.replace(/\s+/g, ' ').trim().length
  const kept = out.slice(0, lines)
  if (isCut && kept.length > 0) kept[kept.length - 1] = cut(`${kept[kept.length - 1]}…`, width)
  return kept.join('\n')
}

// Cuts the middle, so sibling repos keep the ends that tell them apart
// (acme-st…ont-api, acme-st…t-theme).
function squeeze(text: string, width: number) {
  if (text.length <= width) return text
  if (width < 5) return cut(text, width)
  const head = Math.ceil((width - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`
}

// A path under the home folder as ~/…; any other path as it is.
const tilde = (path: string) =>
  home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

// A GitHub-style identicon for the session: a 5×5 mirrored pattern in one
// color, a pixel to a column and two to a cell's height (▀ / ▄ / █). The
// same session id draws the same face everywhere.
const DEFAULT = 0x01000000

function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

function rgb(hue: number, s: number, l: number) {
  const k = (n: number) => (n + hue / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}

// The face sits in a stage the card's width and FACE_ROWS tall, two pixel
// rows to a cell, so it can wander: (x, y) is its top-left pixel.
// The crate a working face carries: Claude's orange, BOX_PX square.
const BOX_COLOR = 0xd97757
const BOX_PX = 2

// Where the face's top-left pixel is, and the crate's when there is one.
type Pose = { x: number; y: number; box?: { x: number; y: number } }

function faceCells(id: string, columns: number, rows: number, { x, y, box }: Pose) {
  const h = hash(id)
  // Greens and teals, or violets and pinks: never the status oranges and blues.
  const pick = (h >>> 15) % 130
  const color = rgb(pick < 75 ? 100 + pick : 275 + (pick - 75), 0.65, 0.6)
  // 15 bits fill the left three columns; the right two mirror them.
  const on = (fx: number, fy: number) => ((h >>> ((fx < 3 ? fx : 4 - fx) * 5 + fy)) & 1) === 1
  // The colour of a stage pixel, or undefined where it is empty.
  const px = (sx: number, sy: number) => {
    const fx = sx - x
    const fy = sy - y
    if (fx >= 0 && fy >= 0 && fx < FACE_PX && fy < FACE_PX && on(fx, fy)) return color
    if (box && sx >= box.x && sx < box.x + BOX_PX && sy >= box.y && sy < box.y + BOX_PX) return BOX_COLOR
    return undefined
  }
  const words: number[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const top = px(col, row * 2)
      const bottom = px(col, row * 2 + 1)
      if (top !== undefined && top === bottom) words.push(0x2588, top, DEFAULT)
      else if (top !== undefined) words.push(0x2580, top, bottom ?? DEFAULT)
      else if (bottom !== undefined) words.push(0x2584, bottom, DEFAULT)
      else words.push(0x20, DEFAULT, DEFAULT)
    }
  }
  const bytes = new Uint8Array(Uint32Array.from(words).buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// Where each face stands is a function of its id, its status and the wall
// clock alone, so every window's pane draws it in the same place at the same
// moment. Motion carries status:
// - carry (working): walks left to right with a crate, a column per STEP_MS,
//   sets it down, walks back empty-handed, picks up the next one.
// - bob (waiting on the person): stays centered and bobs a pixel, BOB_MS up
//   then BOB_MS down, each face at its own phase.
// - still (idle, done, or the person turned motion off with /sessions-motion).
const FACE_PX = 5
const STEP_MS = 450
const PAUSE_MS = 900
const BOB_MS = 700
type Motion = 'carry' | 'bob' | 'still'
// The faces the pane last drew: their stage size and motion, by id.
type Stage = { columns: number; rows: number; motion: Motion }
const stages = new Map<string, Stage>()

const motionOf = (status: DeckStatus): Motion =>
  isStill ? 'still' : status === 'working' ? 'carry' : RANK[status] <= RANK.finished ? 'bob' : 'still'

function poseAt(id: string, { columns, rows, motion }: Stage, now: number): Pose {
  const restY = rows * 2 - FACE_PX
  if (motion === 'still') return { x: Math.floor((columns - FACE_PX) / 2), y: restY }
  if (motion === 'bob') {
    const phase = Math.floor((now + (hash(id) % (2 * BOB_MS))) / BOB_MS) % 2
    return { x: Math.floor((columns - FACE_PX) / 2), y: restY - phase }
  }
  // The crate rides in front of the face, its bottom on the ground.
  const range = Math.max(0, columns - FACE_PX - 1 - BOX_PX)
  const leg = range * STEP_MS
  const cycle = 2 * leg + 2 * PAUSE_MS
  const t = (now + (hash(id) % cycle)) % cycle
  const crateY = rows * 2 - BOX_PX
  const step = (ms: number) => Math.min(range, Math.floor(ms / STEP_MS))
  // A step lifts the face a pixel every other column.
  const gait = (n: number) => restY - (n % 2)
  if (t < leg) {
    const x = step(t)
    return { x, y: gait(x), box: { x: x + FACE_PX + 1, y: crateY - (x % 2) } }
  }
  if (t < leg + PAUSE_MS) return { x: range, y: restY, box: { x: range + FACE_PX + 1, y: crateY } }
  if (t < 2 * leg + PAUSE_MS) {
    const back = step(t - leg - PAUSE_MS)
    return { x: range - back, y: gait(back) }
  }
  // Back at the start: the next crate is waiting.
  return { x: 0, y: restY, box: { x: FACE_PX + 1, y: crateY } }
}

const shown = new Map<string, string>()

async function animate($: EngineInterface) {
  const now = await $.clock.now()
  for (const [id, stage] of stages) {
    const pose = poseAt(id, stage, now)
    const seen = JSON.stringify(pose)
    if (shown.get(id) === seen) continue
    shown.set(id, seen)
    const done = await $.ui
      .blit({
        requestId: PANE,
        key: `face-${id}`,
        columns: stage.columns,
        rows: stage.rows,
        cells: faceCells(id, stage.columns, stage.rows, pose),
      })
      .catch(() => ({ deny: 'failed' }))
    // Not drawn now (the pane closed, the card left): wait for the next draw.
    if ('deny' in done && done.deny !== undefined) stages.delete(id)
  }
}

// The pane's title in 5×7 pixel letters, two pixel rows to a cell, shaded
// from cyan to violet across its width.
const TITLE = 'SESSION DECK'
const FONT: Record<string, string[]> = {
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
}
const GLYPH_PX = 5
const SPACE_PX = 3
const TITLE_ROWS = 4

const titleWidth = (text: string) =>
  [...text].reduce((sum, ch, i) => sum + (ch === ' ' ? SPACE_PX : GLYPH_PX) + (i > 0 ? 1 : 0), 0)

function titleCells(text: string) {
  const columns = titleWidth(text)
  const lit = Array.from({ length: TITLE_ROWS * 2 }, () => new Array<boolean>(columns).fill(false))
  let left = 0
  for (const ch of text) {
    const glyph = FONT[ch]
    if (glyph !== undefined) {
      glyph.forEach((line, y) => {
        for (let x = 0; x < GLYPH_PX; x++) if (line[x] === '#') lit[y]![left + x] = true
      })
    }
    left += (ch === ' ' ? SPACE_PX : GLYPH_PX) + 1
  }
  const words: number[] = []
  for (let row = 0; row < TITLE_ROWS; row++) {
    for (let col = 0; col < columns; col++) {
      const color = rgb(190 + (80 * col) / Math.max(1, columns - 1), 0.85, 0.68)
      const top = lit[row * 2]![col]
      const bottom = lit[row * 2 + 1]![col]
      if (top && bottom) words.push(0x2588, color, DEFAULT)
      else if (top) words.push(0x2580, color, DEFAULT)
      else if (bottom) words.push(0x2584, color, DEFAULT)
      else words.push(0x20, DEFAULT, DEFAULT)
    }
  }
  const bytes = new Uint8Array(Uint32Array.from(words).buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { columns, cells: btoa(binary) }
}

// AppleScript that brings forward the tab holding the tty in argv, per
// TERM_PROGRAM; it answers "ok" when it found one.
const FOCUS: Record<string, string[]> = {
  Apple_Terminal: [
    'on run argv',
    'tell application "Terminal"',
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'if tty of t is item 1 of argv then',
    'set miniaturized of w to false',
    'set selected of t to true',
    'set index of w to 1',
    'activate',
    'return "ok"',
    'end if',
    'end repeat',
    'end repeat',
    'end tell',
    'end run',
  ],
  'iTerm.app': [
    'on run argv',
    'tell application "iTerm2"',
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'repeat with s in sessions of t',
    'if tty of s is item 1 of argv then',
    'select w',
    'select t',
    'select s',
    'activate',
    'return "ok"',
    'end if',
    'end repeat',
    'end repeat',
    'end repeat',
    'end tell',
    'end run',
  ],
}

// A background session has no tab: a new Terminal window attaches to it.
const ATTACH = [
  'on run argv',
  'tell application "Terminal"',
  'do script "claude attach " & quoted form of (item 1 of argv)',
  'activate',
  'end tell',
  'return "ok"',
  'end run',
]

async function osascript($: EngineInterface, script: string[], arg: string) {
  const lines = script.flatMap(line => ['-e', line])
  const ran = await $.process
    .run(['/usr/bin/osascript', ...lines, arg], { timeoutMs: 10000 })
    .catch((error: unknown) => ({ stdout: '', stderr: String(error) }))
  return ran.stdout.trim() === 'ok' ? '' : ran.stderr.trim() || 'not found'
}

// Brings the session forward; answers '' when it did, else why not.
// The tty of the tab in front, when the terminal app itself is in front.
const FRONT_TAB: Record<string, string[]> = {
  Apple_Terminal: [
    'tell application "Terminal"',
    'if frontmost then return tty of selected tab of front window',
    'end tell',
    'return ""',
  ],
  'iTerm.app': [
    'tell application "iTerm2"',
    'if frontmost then return tty of current session of current window',
    'end tell',
    'return ""',
  ],
}

// Whether this session's own tab is the one the person looks at; `unknown`
// where the terminal or the tab cannot be told.
async function tabOf($: EngineInterface): Promise<'front' | 'behind' | 'unknown'> {
  const script = FRONT_TAB[app]
  const mine = (await read($, view)).sessions.find(one => one.id === me?.id)?.tty
  if (script === undefined || mine === undefined) return 'unknown'
  const ran = await $.process
    .run(['/usr/bin/osascript', ...script.flatMap(line => ['-e', line])], { timeoutMs: 5000 })
    .catch(() => undefined)
  if (ran === undefined) return 'unknown'
  return ran.stdout.trim() === mine ? 'front' : 'behind'
}

// A finished reply turns idle once its own tab is the one the person looks at.
async function markSeen($: EngineInterface) {
  if (me?.status !== 'finished') return
  if ((await tabOf($)) === 'front') await setStatus($, 'idle')
}

const answerFile = (id: string) => `${dir}/answers/${id}.json`

// The session's permission mode, as its transcript last recorded it.
async function modeOf($: EngineInterface) {
  if (me === undefined) return undefined
  const ran = await $.process
    .run([
      '/bin/sh',
      '-c',
      `/usr/bin/tail -c 200000 "$1" | /usr/bin/grep -o '"permissionMode":"[a-zA-Z]*"' | /usr/bin/tail -1`,
      'sh',
      transcriptOf({ cwd, sessionId: me.id }),
    ])
    .catch(() => undefined)
  return /"permissionMode":"([a-zA-Z]+)"/.exec(ran?.stdout ?? '')?.[1]
}

// An ask is held only where its dialog is the mode's way to settle it and
// the person is surely looking elsewhere: an unknown tab is not held.
async function isHoldable($: EngineInterface) {
  if (!HOLDABLE_MODES.has((await modeOf($)) ?? '')) return false
  return (await tabOf($)) === 'behind'
}

const lineCount = (text: unknown) => (typeof text === 'string' && text !== '' ? text.split('\n').length : 0)

// The call as the tray draws it: Bash's command, a file tool's path with the
// lines it adds and removes, else the tool's input in short.
function previewOf(tool: string, input: unknown) {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (typeof args.command === 'string') return args.command.trim()
  if (typeof args.file_path === 'string') {
    const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : [args]
    const added = edits.reduce((n, one) => n + lineCount(one.new_string ?? one.content), 0)
    const removed = edits.reduce((n, one) => n + lineCount(one.old_string), 0)
    return `${tilde(args.file_path)} (+${added} −${removed})`
  }
  if (typeof args.url === 'string') return args.url
  return JSON.stringify(input ?? {})
}

// Commands that delete, publish, escalate or pipe the network into a shell.
const DANGER =
  /\brm\s+-[a-z]*[rf]|\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)|--force\b|\bsudo\b|\bchmod\s+-R|\b(npm|yarn|pnpm)\s+publish|\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b|\bdrop\s+(table|database)\b|\bkubectl\s+delete|\bdd\s+if=/i

function riskOf(tool: string, input: unknown, isReadOnly: boolean | undefined): DeckAsk['risk'] {
  const command = (input as { command?: unknown } | null)?.command
  if (typeof command === 'string' && DANGER.test(command)) return 'danger'
  const path = (input as { file_path?: unknown } | null)?.file_path
  if (typeof path === 'string' && cwd !== '' && !path.startsWith(`${cwd}/`)) return 'danger'
  return isReadOnly ? 'read' : 'write'
}

const sleep = ($: EngineInterface, ms: number) => new Promise<void>(resolve => $.clock.after(ms, resolve))

// Holds one ask until a deck answers it, answering with that; undefined
// once its tab comes to the front or HOLD_MS passes, for the dialog to take.
async function holdAsk(
  $: EngineInterface,
  e: { tool: string; input: unknown; tool_use_id?: string; isReadOnly?: true },
): Promise<{ decision: 'allow' | 'deny'; reason: string } | undefined> {
  if (me === undefined || e.tool_use_id === undefined) return undefined
  const since = await $.clock.now()
  const ask: DeckAsk = {
    id: e.tool_use_id,
    tool: e.tool,
    preview: previewOf(e.tool, e.input),
    risk: riskOf(e.tool, e.input, e.isReadOnly),
    at: since,
  }
  const path = answerFile(me.id)
  // An answer left from an earlier ask is not this one's.
  await $.process.run(['rm', '-f', path]).catch(() => {})
  me = { ...me, ask }
  await setStatus($, 'permission')
  try {
    while ((await $.clock.now()) - since < HOLD_MS) {
      await sleep($, POLL_MS)
      const answer = await $.fs
        .read(path)
        .then(text => JSON.parse(String(text)) as DeckAnswer)
        .catch(() => undefined)
      if (answer?.askId === ask.id) {
        await $.process.run(['rm', '-f', path]).catch(() => {})
        if (answer.decision === 'allow') return { decision: 'allow', reason: 'Allowed from the Session Deck' }
        const why = answer.reason?.trim()
        return {
          decision: 'deny',
          reason: why ? `The person denied this from the Session Deck: ${why}` : 'The person denied this from the Session Deck.',
        }
      }
      if ((await tabOf($)) === 'front') break
    }
    return undefined
  } finally {
    // Answered or handed on, the deck stops offering it; a dialog it was
    // handed to shows as Claude Code's own "waiting for a permission prompt".
    if (me !== undefined) me = { ...me, ask: undefined }
    await setStatus($, 'working')
  }
}

// A deck's answer to another session's held ask.
async function answer($: EngineInterface, one: DeckSession, decision: 'allow' | 'deny', reason?: string) {
  if (one.ask === undefined) return
  const said: DeckAnswer = { askId: one.ask.id, decision, reason, at: await $.clock.now() }
  await $.fs.write(answerFile(one.id), JSON.stringify(said))
  const askId = one.ask.id
  // Kept only for asks still on the deck.
  const live = new Set((await read($, view)).sessions.flatMap(other => (other.ask ? [other.ask.id] : [])))
  await update($, sent, had => ({
    ...Object.fromEntries(Object.entries(had).filter(([id]) => live.has(id))),
    [askId]: decision,
  }))
  await update($, denying, () => '')
  await update($, confirmingAsk, () => '')
}

const closedFile = () => `${dir}/last-closed.json`
const isSessionId = (id: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)

// The day as the Mac's own clock and time zone have it.
async function today($: EngineInterface) {
  const stamp = await $.process
    .run(['/bin/date', '+%Y-%m-%d|%A, %B %-d, %Y|%-I:%M %p|%a %-I:%M %p|%z'])
    .catch(() => undefined)
  const midnight = await $.process.run(['/bin/date', '-v0H', '-v0M', '-v0S', '+%s']).catch(() => undefined)
  const [file = 'today', heading = 'Today', time = '', label = '', zone = '+0000'] = (
    stamp?.stdout.trim() ?? ''
  ).split('|')
  // The Mac's offset from UTC (-1000 → -10 h), to tell times of day in its zone.
  const sign = zone.startsWith('-') ? -1 : 1
  const offsetMs = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60_000 || 0
  return { file, heading, time, label, offsetMs, since: Number(midnight?.stdout.trim() ?? 0) * 1000 }
}

type Day = Awaited<ReturnType<typeof today>>

// 42m, 1h 42m; under a minute, <1m.
function span(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// 9:05 AM in the Mac's zone.
function clockTime(at: number, offsetMs: number) {
  const local = new Date(at + offsetMs)
  const h = local.getUTCHours()
  return `${h % 12 || 12}:${String(local.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

// What a session's transcript says of today: how long Claude worked (each
// reply's own duration, summed), how many replies, the first and last moment
// anything happened, the files it edited and the branch it was on.
type SessionDay = {
  activeMs: number
  replies: number
  firstAt?: number
  lastAt?: number
  files: Set<string>
  branch?: string
}

// A whole day can be many megabytes of transcript, so rather than read it,
// three searches pull out only what the totals need: every reply's duration
// row, every row's own timestamp by line, and every edit's file path by line
// (a row's own fields are unescaped; the same words inside content are not).
async function dayOf($: EngineInterface, one: DeckSession, since: number): Promise<SessionDay> {
  const path = transcriptOf({ cwd: one.cwd, sessionId: one.id })
  const grep = (...args: string[]) =>
    $.process
      .run(['/usr/bin/grep', ...args, path], { timeoutMs: 15000 })
      .then(ran => ran.stdout)
      .catch(() => '')
  const [durations, stamps, edits] = await Promise.all([
    grep('"subtype":"turn_duration"'),
    grep('-noE', '"timestamp":"[^"]*"'),
    grep(
      '-noE',
      '"name":"(Edit|Write|MultiEdit|NotebookEdit)","input":\\{"(file_path|notebook_path)":"[^"]*"',
    ),
  ])
  const found: SessionDay = { activeMs: 0, replies: 0, files: new Set() }
  for (const line of durations.split('\n')) {
    let row: { durationMs?: number; timestamp?: string; gitBranch?: string }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!(Date.parse(row.timestamp ?? '') >= since) || typeof row.durationMs !== 'number') continue
    found.activeMs += row.durationMs
    found.replies++
    if (row.gitBranch) found.branch = row.gitBranch
  }
  // Each line's own time; the first moment and the last anything happened.
  const lineAt = new Map<string, number>()
  for (const hit of stamps.split('\n')) {
    const match = /^(\d+):"timestamp":"([^"]*)"$/.exec(hit)
    if (match === null || lineAt.has(match[1] ?? '')) continue
    const at = Date.parse(match[2] ?? '')
    lineAt.set(match[1] ?? '', at)
    if (!(at >= since)) continue
    found.firstAt = Math.min(found.firstAt ?? at, at)
    found.lastAt = Math.max(found.lastAt ?? at, at)
  }
  // Project files only: Claude's own notes under ~/.claude are not the day's work.
  for (const hit of edits.split('\n')) {
    const match = /^(\d+):.*"(?:file_path|notebook_path)":"([^"]*)"$/.exec(hit)
    if (match === null || !((lineAt.get(match[1] ?? '') ?? 0) >= since)) continue
    const file = match[2] ?? ''
    if (file !== '' && !file.startsWith(`${home}/.claude/`)) found.files.add(file)
  }
  return found
}

// A repo's day: commit subjects since midnight, files changed but not
// committed, and its branch. Undefined when the folder is not a git repo.
type RepoDay = { commits: string[]; uncommitted: number; branch: string }

async function repoOf($: EngineInterface, cwd: string, since: number): Promise<RepoDay | undefined> {
  const git = (...args: string[]) =>
    $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 10000 }).catch(() => undefined)
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === undefined || branch.exitCode !== 0) return undefined
  const log = await git('log', `--since=@${Math.floor(since / 1000)}`, '--pretty=%s')
  const status = await git('status', '--porcelain')
  return {
    branch: branch.stdout.trim(),
    commits: (log?.stdout ?? '').split('\n').filter(Boolean),
    uncommitted: (status?.stdout ?? '').split('\n').filter(Boolean).length,
  }
}

// Ticket ids (ABC-123) in commit subjects and branch names.
function ticketsIn(texts: string[]) {
  const found = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(/\b([A-Za-z]{2,10})-(\d{1,6})\b/g)) {
      const key = match[1] ?? ''
      // Words that only look like ids in branch names ("feature-2", "fix-12").
      if (/^(feature|fix|bugfix|hotfix|release|prod|stage|staging|test|wip|v)$/i.test(key)) continue
      found.add(`${key.toUpperCase()}-${match[2]}`)
    }
  }
  return [...found].sort()
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const RECAP_SYSTEM = [
  'You write an end-of-day recap of one Claude Code session for the developer who ran it.',
  'Answer with exactly this Markdown and nothing else:',
  '**Done**',
  '- ...',
  '**Left to do**',
  '- ...',
  'At most 4 bullets under Done and 3 under Left to do, each under 20 words.',
  'Name the files, features and decisions concretely. If nothing is left, write "- Nothing obvious".',
].join('\n')

// One session's Done / Left to do, from what was said in it today (or, if
// nothing today, its latest exchanges).
async function recapOf($: EngineInterface, one: DeckSession, since: number) {
  const tail = await $.process
    .run(['/usr/bin/tail', '-c', '400000', transcriptOf({ cwd: one.cwd, sessionId: one.id })])
    .catch(() => undefined)
  const raw = tail?.stdout ?? ''
  const said = linesOf(raw, since).length > 0 ? linesOf(raw, since) : linesOf(raw).slice(-12)
  const conversation = said
    .map(line => `${line.role === 'user' ? 'Developer' : 'Claude'}: ${line.text.slice(0, 1200)}`)
    .join('\n')
    .slice(-10000)
  if (conversation === '') return '- No conversation to summarize.'
  const answer = await $.model
    .complete({
      model: 'haiku',
      maxTokens: 400,
      timeoutMs: 40000,
      system: RECAP_SYSTEM,
      prompt: `Project folder: ${one.cwd}\nFirst request: ${one.title.slice(0, 1000)}\n\nToday's conversation:\n${conversation}`,
    })
    .catch(() => undefined)
  if (answer?.isAnswered !== true) return "- (Couldn't write a summary: the model didn't answer.)"
  return answer.text.trim()
}

// Writes the day's summary to ~/session-deck-logs/<date>.md, adding to the
// file when Close all already ran today; answers its path.
async function writeDigest($: EngineInterface, sessions: DeckSession[], day: Day) {
  let written = 0
  const progress = () =>
    update($, closing, () => `Writing today's summary… ${written} of ${sessions.length} sessions`)
  await progress()
  const [recaps, days, repos] = await Promise.all([
    Promise.all(
      sessions.map(one =>
        recapOf($, one, day.since).then(async recap => {
          written++
          await progress()
          return recap
        }),
      ),
    ),
    Promise.all(sessions.map(one => dayOf($, one, day.since))),
    // One look per repo, however many sessions work in it.
    Promise.all(
      [...new Set(sessions.map(one => one.cwd))].map(
        async cwd => [cwd, await repoOf($, cwd, day.since)] as const,
      ),
    ).then(entries => new Map(entries)),
  ])
  const sections = sessions.map((one, i) => {
    const project = one.cwd.split('/').filter(Boolean).at(-1) ?? one.cwd
    const engine =
      one.model === undefined ? '' : ` · ${[modelName(one.model), one.effort].filter(Boolean).join(' · ')}`
    const today = days[i]
    const repo = repos.get(one.cwd)
    const when =
      today?.firstAt !== undefined && today.lastAt !== undefined
        ? `${clockTime(today.firstAt, day.offsetMs)} – ${clockTime(today.lastAt, day.offsetMs)}`
        : undefined
    const branch = repo?.branch ?? today?.branch
    const time = [
      today !== undefined && today.replies > 0
        ? `Active ${span(today.activeMs)} across ${plural(today.replies, 'reply', 'replies')}`
        : 'No replies today',
      when,
      branch === undefined ? undefined : `\`${branch}\``,
      repo === undefined ? undefined : plural(repo.commits.length, 'commit'),
      repo !== undefined && repo.uncommitted > 0
        ? `⚠ ${plural(repo.uncommitted, 'file')} uncommitted`
        : undefined,
    ]
      .filter(Boolean)
      .join(' · ')
    return [
      `### ${project}${engine}`,
      `\`${one.cwd}\``,
      '',
      time,
      '',
      recaps[i] ?? '',
      '',
      `Resume: \`cd ${quote(one.cwd)} && claude --resume ${one.id}\``,
    ].join('\n')
  })
  const count = plural(sessions.length, 'session')
  // The day at a glance: the totals across every session and repo.
  const activeMs = days.reduce((sum, d) => sum + d.activeMs, 0)
  const edited = new Set(days.flatMap(d => [...d.files]))
  const repoList = [...repos.entries()].flatMap(([cwd, repo]) => (repo === undefined ? [] : [{ cwd, repo }]))
  const commits = repoList.reduce((sum, r) => sum + r.repo.commits.length, 0)
  const tickets = ticketsIn(repoList.flatMap(r => [...r.repo.commits, r.repo.branch]))
  const unsaved = repoList.filter(r => r.repo.uncommitted > 0)
  const glance = [
    `**At a glance:** ${[count, `${span(activeMs)} active`, plural(commits, 'commit'), `${plural(edited.size, 'file')} edited`].join(' · ')}`,
    tickets.length > 0 ? `**Tickets:** ${tickets.join(', ')}` : undefined,
    unsaved.length > 0
      ? `**⚠ Uncommitted:** ${unsaved.map(r => `${projectName(r.cwd)} (${plural(r.repo.uncommitted, 'file')})`).join(', ')}`
      : undefined,
  ]
    .filter(Boolean)
    .join('  \n')
  const part = [`## Closed at ${day.time} · ${count}`, '', glance, '', sections.join('\n\n')].join('\n')
  const path = `${home}/session-deck-logs/${day.file}.md`
  const had = await $.fs.read(path).catch(() => '')
  const text =
    typeof had === 'string' && had !== ''
      ? `${had.trimEnd()}\n\n${part}\n`
      : `# Session Deck: ${day.heading}\n\n${part}\n`
  await $.fs.write(path, text)
  return path
}

// How long the saved summary's path stays on screen before sessions close.
const SAVED_MS = 2500

// Close all: writes the day's summary, keeps the list for Resume, shows where
// the summary went, then closes.
async function closeAll($: EngineInterface, sessions: DeckSession[]) {
  const now = await $.clock.now()
  const day = await today($)
  const digest = await writeDigest($, sessions, day).catch(() => undefined)
  const closed: DeckClosed = {
    at: now,
    sessions: sessions.map(one => ({ id: one.id, cwd: one.cwd, title: one.summary ?? one.title })),
    digest,
    label: day.label || undefined,
  }
  await $.fs.write(closedFile(), JSON.stringify(closed))
  await update($, closing, () =>
    digest === undefined
      ? "Couldn't write today's summary · closing sessions…"
      : `Saved ${tilde(digest)} · closing sessions…`,
  )
  $.clock.after(SAVED_MS, () => {
    void endSessions($, sessions)
  })
}

// Stops the background sessions, asks every interactive one to quit as /exit
// would (SIGTERM: the transcript is already on disk), and this session last.
async function endSessions($: EngineInterface, sessions: DeckSession[]) {
  for (const one of sessions.filter(one => one.isBackground && one.shortId)) {
    await $.process.run(['claude', 'stop', one.shortId ?? ''], { timeoutMs: 15000 }).catch(() => {})
  }
  const others = sessions.filter(one => !one.isBackground && one.pid && one.id !== me?.id)
  if (others.length > 0) {
    await $.process.run(['/bin/kill', '-TERM', ...others.map(one => String(one.pid))]).catch(() => {})
  }
  const self = sessions.find(one => one.id === me?.id)?.pid
  if (self) {
    $.clock.after(300, () => {
      void $.process.run(['/bin/kill', '-TERM', String(self)]).catch(() => {})
    })
  }
  // Still here (this session was not among them, or did not quit): clear it.
  $.clock.after(5000, () => {
    void update($, closing, () => '')
  })
}

// Opens each closed session again, in its own folder: the first in a new
// window, the rest as tabs of it. Terminal's scripting makes windows only, so
// a tab is ⌘T pressed through System Events, which needs Terminal allowed
// under Privacy & Security › Accessibility; until it is, the rest open as
// windows and the script answers "windows". iTerm2 makes tabs itself.
const OPEN_TABS: Record<string, string[]> = {
  Apple_Terminal: [
    'on run argv',
    'tell application "Terminal"',
    'activate',
    'do script (item 1 of argv)',
    'end tell',
    'set fellBack to false',
    'repeat with i from 2 to count of argv',
    'set opened to false',
    'try',
    'tell application "System Events" to tell process "Terminal" to keystroke "t" using command down',
    'delay 0.4',
    'tell application "Terminal" to do script (item i of argv) in selected tab of front window',
    'set opened to true',
    'end try',
    'if not opened then',
    'tell application "Terminal" to do script (item i of argv)',
    'set fellBack to true',
    'end if',
    'end repeat',
    'if fellBack then return "windows"',
    'return "ok"',
    'end run',
  ],
  'iTerm.app': [
    'on run argv',
    'tell application "iTerm2"',
    'activate',
    'set w to (create window with default profile)',
    'tell current session of w to write text (item 1 of argv)',
    'repeat with i from 2 to count of argv',
    'tell w to create tab with default profile',
    'tell current session of w to write text (item i of argv)',
    'end repeat',
    'end tell',
    'return "ok"',
    'end run',
  ],
}

// Answers how it went: opened (as tabs, or as windows for want of the
// Accessibility permission), or the commands to run by hand.
type Resumed = { how: 'tabs' } | { how: 'windows' } | { how: 'manual'; commands: string }

async function resumeAll($: EngineInterface, closed: DeckClosed, running: DeckSession[]): Promise<Resumed> {
  const commands = closed.sessions
    .filter(one => isSessionId(one.id) && !running.some(r => r.id === one.id))
    .map(one => `cd ${quote(one.cwd)} && claude --resume ${one.id}`)
  if (commands.length === 0) return { how: 'tabs' }
  const script = OPEN_TABS[app]
  const lines = script?.flatMap(line => ['-e', line]) ?? []
  const ran =
    script === undefined
      ? undefined
      : await $.process
          .run(['/usr/bin/osascript', ...lines, ...commands], { timeoutMs: 60000 })
          .catch(() => undefined)
  const said = ran?.stdout.trim()
  if (said !== 'ok' && said !== 'windows') return { how: 'manual', commands: commands.join('\n') }
  await $.fs.write(closedFile(), JSON.stringify({ ...closed, resumedAt: await $.clock.now() }))
  await refresh($)
  return said === 'ok' ? { how: 'tabs' } : { how: 'windows' }
}

async function jump($: EngineInterface, one: DeckSession) {
  if (one.isBackground) {
    if (!one.shortId) return 'no id to attach'
    if (app !== 'Apple_Terminal') return 'opens only in Terminal'
    return osascript($, ATTACH, one.shortId)
  }
  const script = FOCUS[app]
  if (script === undefined) return `can't switch tabs in ${app || 'this terminal'}`
  if (!one.tty) return 'no tab found'
  return osascript($, script, one.tty)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd ?? ''
    home = (await $.env.get('HOME')) ?? ''
    app = (await $.env.get('TERM_PROGRAM')) ?? ''
    dir = `${home}/.claude/session-deck`
    const now = await $.clock.now()
    me = { id: await $.session.id(), status: 'idle', changedAt: now, beatAt: now }
    await report($)
    await prune($)
    await refresh($)

    $.clock.every(TICK_MS, () => {
      void markSeen($)
        .then(() => report($))
        .then(() => refresh($))
    })
    $.clock.every(FRAME_MS, () => {
      void animate($)
    })

    isStill = (await $.store.get('still').catch(() => false)) === true
    await $.command.register({
      name: 'sessions',
      description: 'Show every running Claude Code session in a pane',
    })
    await $.command.register({
      name: 'sessions-motion',
      description: "Turn the Session Deck faces' motion off or back on",
    })
    // At start the terminal may not have reported its width yet, and an open
    // made then waits for a resize: ask again a few times as it settles.
    for (const ms of [0, 500, 2000, 5000]) {
      $.clock.after(ms, () => {
        void $.ui.open({ id: PANE, title: 'Sessions', columns: PANE_COLUMNS })
      })
    }

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Sessions', columns: PANE_COLUMNS })

    return { text: 'Sessions pane opened.' }
  })

  on('command.run', { command: 'sessions-motion' }, async $ => {
    isStill = !isStill
    await $.store.set('still', isStill)
    await refresh($)

    return { text: isStill ? 'Session Deck faces hold still.' : 'Session Deck faces move again.' }
  })

  on('session.end', async ($, e, next) => {
    if (me !== undefined) await $.process.run(['rm', '-f', `${dir}/${me.id}.json`, answerFile(me.id)]).catch(() => {})

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (me !== undefined) me = { ...me, progressAt: await $.clock.now() }
      await setStatus($, 'working')
    }

    return next(e)
  })

  // A reply that ended while the person looked elsewhere waits on them; one
  // they interrupted, or watched end, does not.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A turn's end leaves nothing running.
      inFlight.clear()
      if (me !== undefined) me = { ...me, progressAt: await $.clock.now(), running: undefined }
      await setStatus($, e.isAborted ? 'idle' : 'finished')
      await markSeen($)
    }

    return next(e)
  })

  // A permission ask the person would answer in this tab's dialog is held
  // for the deck instead while the tab is not in front: the dialog is drawn
  // only once this returns. The tab coming to the front, or HOLD_MS, hands it
  // on to the dialog, as does any failure here.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.tool_use_id === undefined || e.approver === 'host') return verdict
    if (!(await isHoldable($))) return verdict

    return (await holdAsk($, e)) ?? verdict
  }).catch(($, e, next) => next(e))

  // A call beginning or ending is progress, a subagent's too; the main
  // loop's calls are what runs, and the same one failing again is a streak.
  on('tool.call', async ($, e, next) => {
    const isQuestion = e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode'
    if (isQuestion) await setStatus($, 'question')
    const isMain = e.agentId === undefined
    const call = ++calls
    if (isMain) inFlight.set(call, { tool: e.tool, since: await $.clock.now() })
    await note($, { progressAt: await $.clock.now(), running: oldestRunning() })
    try {
      const ran = await next(e)
      if (isMain) {
        const key = callKey(e)
        lastFail =
          'isError' in ran && ran.isError
            ? { key, tool: e.tool, count: lastFail.key === key ? lastFail.count + 1 : 1 }
            : { key: '', tool: '', count: 0 }
      }
      if (me?.status === 'permission' || me?.status === 'question') await setStatus($, 'working')

      return ran
    } finally {
      inFlight.delete(call)
      await note($, {
        progressAt: await $.clock.now(),
        running: oldestRunning(),
        failing: lastFail.count >= LOOP_COUNT ? { tool: lastFail.tool, count: lastFail.count } : undefined,
      })
    }
  }).catch(($, e, next) => next(e))

  // The context window's fill and the cost so far, as the engine measures them.
  on('session.measure', async ($, e, next) => {
    const { percent, window } = e.context
    await note($, {
      context: percent === undefined ? me?.context : { percent, window },
      costUsd: e.cost?.usd ?? me?.costUsd,
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Only the terminal draws cells (another surface's table may name Raster
    // and draw nothing); elsewhere the card goes without a face.
    const Raster = e.surface === 'terminal' && 'Raster' in ui ? ui.Raster : undefined
    const Markdown = 'Markdown' in ui ? ui.Markdown : undefined
    const Input = 'Input' in ui ? ui.Input : undefined
    const { now, sessions, closed } = await read($, view)
    const denyingId = await read($, denying)
    const confirmingId = await read($, confirmingAsk)
    const answered = await read($, sent)
    const confirming = await read($, isConfirming)
    const progress = await read($, closing)
    const showingDigest = (await read($, isShowingDigest)) && closed?.digest !== undefined
    const digestText = showingDigest
      ? await $.fs
          .read(closed?.digest ?? '')
          .then(text => (typeof text === 'string' ? text : ''))
          .catch(() => '')
      : ''
    // Closed sessions not running again yet, offered for RESUME_MS.
    const resumable =
      closed === undefined || closed.resumedAt !== undefined || now - closed.at > RESUME_MS
        ? []
        : closed.sessions.filter(one => !sessions.some(running => running.id === one.id))
    const width = Math.max(MIN_CARD, (e.props.bodyColumns ?? e.viewport?.columns ?? 40) - 2 * PAD_X)
    let perRow = PER_ROW
    while (perRow > 1 && (width - (perRow - 1)) / perRow < MIN_CARD) perRow--
    const card = Math.floor((width - (perRow - 1)) / perRow)
    // Inside the border and its one column of padding each side.
    const inner = card - 4
    const list = [...sessions].sort(byUrgency)
    const rows: DeckSession[][] = []
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow))
    const count = (test: (status: DeckStatus) => boolean) => list.filter(one => test(one.status)).length
    const blocked = count(isBlocked)
    const replied = count(status => status === 'finished')
    const working = count(status => status === 'working')
    const resting = count(status => status === 'idle' || status === 'done')
    const stuck = list.filter(one => alertOf(one, now)?.isStuck).length
    const isMeListed = list.some(one => one.id === me?.id)

    // Brings a session's tab forward; where it can't, copies the command that
    // reaches it.
    const goTo = async (one: DeckSession) => {
      if (one.id === me?.id) return
      const why = await jump($, one)
      if (why === '') return
      const fallback = one.isBackground
        ? `claude attach ${one.shortId ?? one.id}`
        : `cd ${quote(one.cwd)} && claude --resume ${one.id}`
      const copied = await $.ui.copy({ text: fallback, surface: e.surface })
      $.ui.toast(`Couldn't switch to it (${why}). ${copied.isCopied ? 'Copied: ' : ''}${fallback}`)
    }

    // The approval queue: asks held for the deck, oldest first, then sessions
    // whose ask went to their tab's own dialog.
    const held = list
      .filter(one => one.ask !== undefined && answered[one.ask.id] === undefined)
      .sort((a, b) => (a.ask?.at ?? 0) - (b.ask?.at ?? 0))
    const inTab = list.filter(one => one.status === 'permission' && one.ask === undefined && one.id !== me?.id)
    const queue = [...held, ...inTab]
    // A new top arrives with a refresh, so the view's own time is when it showed.
    const topId = queue[0]?.ask?.id ?? queue[0]?.id ?? ''
    if (topId !== top.id) top = { id: topId, at: now }

    // The faces drawn now; the animation repaints only these.
    stages.clear()
    const face = (one: DeckSession) => {
      if (Raster === undefined) return null
      const stage = { columns: inner, rows: FACE_ROWS, motion: motionOf(one.status) }
      stages.set(one.id, stage)
      const pose = poseAt(one.id, stage, now)
      shown.set(one.id, JSON.stringify(pose))
      return (
        <Raster
          key={`face-${one.id}`}
          columns={stage.columns}
          rows={stage.rows}
          cells={faceCells(one.id, stage.columns, stage.rows, pose)}
        />
      )
    }

    const cardOf = (one: DeckSession) => {
      const look = LOOK[one.status]
      const isMe = one.id === me?.id
      const about = one.summary ?? one.title
      // The session's deck number, 1–9 a key that jumps to it once the pane
      // has focus; drawn as "1: ". This session shows its number too, so no
      // window's numbering skips one.
      const hotkey = one.number !== undefined && one.number <= 9 ? String(one.number) : undefined
      const tail = isMe ? ' THIS ' : one.isBackground ? ' bg ›' : ' ›'
      const room = inner - tail.length - (isMe ? 1 : 0) - (hotkey === undefined ? 0 : 3)
      const age = ago(now - one.changedAt)
      // A held ask names its call; one this deck answered says how.
      const said = one.ask === undefined ? undefined : answered[one.ask.id]
      const status =
        said === 'allow'
          ? '✓ allowed'
          : said === 'deny'
            ? '✗ denied'
            : one.ask !== undefined
              ? `${look.glyph} ${one.ask.tool}: ${one.ask.preview}`
              : `${look.glyph} ${look.label}`
      const statusColor = said === 'allow' ? 'success' : said === 'deny' ? 'error' : look.color
      const alert = alertOf(one, now)
      const context = one.health === undefined ? undefined : contextLine(one.health, inner)
      return (
        <Box
          key={one.id}
          flexDirection="column"
          width={card}
          borderStyle={isMe || isBlocked(one.status) ? 'bold' : 'round'}
          borderColor={look.color}
          paddingX={1}
        >
          {face(one)}
          <Button
            key={one.id}
            plain
            hotkey={hotkey}
            onPress={() => goTo(one)}
          >
            <Text bold underline={!isMe}>
              {squeeze(projectName(one.cwd), Math.max(4, room))}
            </Text>
            {isMe ? (
              <Text>
                {' '}
                <Text bold inverse color={THIS_COLOR}>
                  {tail}
                </Text>
              </Text>
            ) : (
              <Text dimColor>{tail}</Text>
            )}
          </Button>
          <Text>
            <Text color={statusColor} bold={isBlocked(one.status)}>
              {cut(status, inner)}
            </Text>
            {status.length + 1 + age.length <= inner && <Text dimColor> {age}</Text>}
          </Text>
          {alert !== undefined && (
            <Text color={alert.color} bold={alert.isStuck}>
              {cut(alert.text, inner)}
            </Text>
          )}
          {one.model !== undefined && <Text dimColor>{engineLine(one.model, one.effort, inner)}</Text>}
          {context !== undefined && (
            <Text color={context.color} dimColor={context.color === undefined}>
              {cut(context.text, inner)}
            </Text>
          )}
          {about !== '' && (
            <Text dimColor={one.summary === undefined}>{clamp(about, inner, SUMMARY_LINES)}</Text>
          )}
        </Box>
      )
    }

    // The tray's top ask in full, with what to do about it; the rest of the
    // queue a line each beneath.
    const RISK_COLOR = { read: 'success', write: 'warning', danger: 'error' } as const
    const guarded = (act: () => Promise<unknown>) => async () => {
      if ((await $.clock.now()) - top.at < LOCK_MS) {
        $.ui.toast('A new request just came up. Press again for it.')
        return
      }
      await act()
    }
    const first = queue[0]
    const ask = first?.ask
    const trayInner = width - 4
    const trayActions =
      first === undefined ? null : ask === undefined ? (
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          <Button key="ask-go" hotkey="j" variant="primary" label="Go to it" onPress={() => goTo(first)} />
        </Box>
      ) : denyingId === ask.id && Input !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Input
            key="ask-deny-reason"
            label="Why? "
            placeholder="optional, the session reads it"
            submitLabel="deny"
            autoFocus
            onSubmit={value => void answer($, first, 'deny', value)}
          />
          <Box flexDirection="row" columnGap={2}>
            <Button key="ask-deny-cancel" label="Cancel" onPress={() => update($, denying, () => '')} />
          </Box>
        </Box>
      ) : confirmingId === ask.id ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="error">
            Allow this risky call?
          </Text>
          <Box flexDirection="row" columnGap={2}>
            <Button
              key="ask-allow-sure"
              hotkey="y"
              label="Yes, allow"
              onPress={guarded(() => answer($, first, 'allow'))}
            />
            <Button
              key="ask-allow-cancel"
              variant="primary"
              label="Cancel"
              onPress={() => update($, confirmingAsk, () => '')}
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          <Button
            key="ask-allow"
            hotkey="y"
            variant="primary"
            label="Allow"
            onPress={guarded(() =>
              ask.risk === 'danger' ? update($, confirmingAsk, () => ask.id) : answer($, first, 'allow'),
            )}
          />
          <Button
            key="ask-deny"
            hotkey="n"
            label={Input === undefined ? 'Deny' : 'Deny…'}
            onPress={guarded(() =>
              Input === undefined ? answer($, first, 'deny') : update($, denying, () => ask.id),
            )}
          />
          <Button key="ask-go" hotkey="j" label="Go to it" onPress={() => goTo(first)} />
        </Box>
      )
    const tray =
      first === undefined ? null : (
        <Box
          key="tray"
          flexDirection="column"
          borderStyle="bold"
          borderColor={WAIT_COLOR}
          paddingX={1}
          marginTop={1}
        >
          <Text bold color={WAIT_COLOR}>
            {queue.length === 1 ? '1 waiting for approval' : `${queue.length} waiting for approval`}
          </Text>
          <Text>
            <Text bold>{squeeze(projectName(first.cwd), Math.max(4, Math.floor(trayInner / 2)))}</Text>
            <Text dimColor> · {ago(now - (ask?.at ?? first.changedAt))}</Text>
          </Text>
          {(first.summary ?? first.title) !== '' && (
            <Text dimColor>{clamp(first.summary ?? first.title, trayInner, 1)}</Text>
          )}
          {ask === undefined ? (
            <Text>Waiting on a permission prompt in its own tab.</Text>
          ) : (
            <Box flexDirection="column">
              <Text>
                <Text bold color={RISK_COLOR[ask.risk]}>
                  {ask.tool}
                </Text>{' '}
                {clamp(ask.preview, Math.max(8, trayInner - ask.tool.length - 1), 3)}
              </Text>
              {ask.risk === 'danger' && (
                <Text color="error">⚠ Risky: deletes, publishes or reaches outside the project</Text>
              )}
            </Box>
          )}
          {trayActions}
          {queue.slice(1, 4).map(one => (
            <Text key={`next-${one.id}`} dimColor>
              {cut(
                `next: ${projectName(one.cwd)} · ${one.ask === undefined ? 'in its tab' : `${one.ask.tool} ${one.ask.preview}`}`,
                trayInner,
              )}
            </Text>
          ))}
          {queue.length > 4 && <Text dimColor>+{queue.length - 4} more</Text>}
        </Box>
      )

    // One line of the counts that matter, loudest first.
    const tally = [
      blocked > 0 && (
        <Text key="blocked" bold color={WAIT_COLOR}>
          {blocked} {blocked === 1 ? 'needs' : 'need'} you
        </Text>
      ),
      replied > 0 && (
        <Text key="replied" color={WAIT_COLOR}>
          {replied} replied
        </Text>
      ),
      stuck > 0 && (
        <Text key="stuck" bold color="warning">
          {stuck} stalled
        </Text>
      ),
      working > 0 && (
        <Text key="working" color="claude">
          {working} working
        </Text>
      ),
      resting > 0 && (
        <Text key="resting" dimColor>
          {resting} idle
        </Text>
      ),
    ].filter(part => part !== false)

    const title =
      Raster !== undefined && list.length <= BIG_TITLE_MAX && titleWidth(TITLE) <= width ? (
        <Box justifyContent="center" marginBottom={1}>
          <Raster key="title" rows={TITLE_ROWS} {...titleCells(TITLE)} />
        </Box>
      ) : Raster !== undefined &&
        list.length <= BIG_TITLE_MAX &&
        TITLE.split(' ').every(word => titleWidth(word) <= width) ? (
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          {TITLE.split(' ').map(word => (
            <Raster key={`title-${word}`} rows={TITLE_ROWS} {...titleCells(word)} />
          ))}
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text bold color={THIS_COLOR}>
            {TITLE}
          </Text>
        </Box>
      )

    const midReply = working
    const footer =
      progress !== '' ? (
        <Box marginTop={1}>
          <Text bold>{progress}</Text>
        </Box>
      ) : confirming ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="warning">
            Close all {list.length} sessions?{isMeListed ? ' This one too.' : ''}
          </Text>
          {midReply > 0 && (
            <Text color="warning">
              {midReply} {midReply === 1 ? 'is' : 'are'} mid-reply and will be cut off.
            </Text>
          )}
          {blocked > 0 && (
            <Text color="warning">
              {blocked} {blocked === 1 ? 'is' : 'are'} waiting on an approval or answer.
            </Text>
          )}
          <Text dimColor>
            Today's summary is saved to ~/session-deck-logs/ first. Conversations are kept, and the Resume
            button reopens them.
          </Text>
          <Box flexDirection="row" columnGap={2} marginTop={1}>
            <Button
              key="close-all-cancel"
              variant="primary"
              label="Cancel"
              onPress={() => update($, isConfirming, () => false)}
            />
            <Button
              key="close-all-yes"
              label="Yes, close all"
              onPress={async () => {
                await update($, isConfirming, () => false)
                await closeAll($, list)
              }}
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {closed !== undefined && resumable.length > 0 && (
            <Text dimColor>
              {cut(
                `Closed ${closed.label ?? ago(now - closed.at) + ' ago'}: ${resumable.map(one => projectName(one.cwd)).join(' · ')}`,
                width,
              )}
            </Text>
          )}
          <Box flexDirection="row" columnGap={2}>
            {closed !== undefined && resumable.length > 0 && (
              <Button
                key="resume-all"
                variant="primary"
                label={`Resume ${resumable.length}`}
                onPress={async () => {
                  const resumed = await resumeAll($, closed, sessions)
                  if (resumed.how === 'tabs') return
                  if (resumed.how === 'windows') {
                    $.ui.toast(
                      'Opened as separate windows. To get tabs, allow Terminal under System Settings › Privacy & Security › Accessibility.',
                      { timeoutMs: 10000 },
                    )
                    return
                  }
                  const copied = await $.ui.copy({ text: resumed.commands, surface: e.surface })
                  $.ui.toast(
                    `Couldn't open them here.${copied.isCopied ? ' Copied the resume commands to the clipboard.' : ''}`,
                  )
                }}
              />
            )}
            {closed?.digest !== undefined && (
              <Button
                key="view-digest"
                label="Last summary"
                onPress={() => update($, isShowingDigest, () => true)}
              />
            )}
            <Box flexGrow={1} />
            {list.length > 0 && (
              <Button key="close-all" label="Close all" onPress={() => update($, isConfirming, () => true)} />
            )}
          </Box>
        </Box>
      )

    return (
      <Box flexDirection="column" paddingX={PAD_X} paddingY={PAD_Y}>
        {title}
        {showingDigest ? (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={2} marginBottom={1}>
              <Button
                key="digest-back"
                variant="primary"
                label="Back to sessions"
                onPress={() => update($, isShowingDigest, () => false)}
              />
              <Text dimColor>{tilde(closed?.digest ?? '')}</Text>
            </Box>
            {Markdown !== undefined ? (
              <Markdown key="digest" text={digestText || '_The summary file is empty or missing._'} />
            ) : (
              <Text>{digestText}</Text>
            )}
          </Box>
        ) : (
          <Box flexDirection="column">
            {list.length === 0 ? (
              <Text dimColor>No Claude Code sessions are running.</Text>
            ) : (
              <Text>
                {tally.map((part, i) => (
                  <Text key={`tally-${i}`}>
                    {i > 0 && <Text dimColor> · </Text>}
                    {part}
                  </Text>
                ))}
              </Text>
            )}
            {tray}
            <Box flexDirection="column" marginTop={1}>
              {rows.map(row => (
                <Box key={row.map(one => one.id).join('+')} flexDirection="row" columnGap={1}>
                  {row.map(cardOf)}
                </Box>
              ))}
            </Box>
            {footer}
          </Box>
        )}
      </Box>
    )
  })
}

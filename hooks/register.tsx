import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const PANE = 'timeline'
const LANGUAGES = ['English', '中文', '日本語', 'Español', 'Français', 'Deutsch'] as const
const LANG_ALIAS: Record<string, string> = {
  en: 'English', zh: '中文', cn: '中文', chinese: '中文',
  ja: '日本語', jp: '日本語', japanese: '日本語',
  es: 'Español', spanish: 'Español',
  fr: 'Français', french: 'Français',
  de: 'Deutsch', german: 'Deutsch',
}

/** A language name, its code, or the start of either. */
export function resolveLanguage(want: string): string | null {
  const w = want.trim().toLowerCase()
  if (w === '') {
    return null
  }
  const alias = LANG_ALIAS[w]
  if (alias !== undefined) {
    return alias
  }
  const exact = LANGUAGES.find(l => l.toLowerCase() === w)
  if (exact !== undefined) {
    return exact
  }
  const byPrefix = LANGUAGES.filter(l => l.toLowerCase().startsWith(w))

  return byPrefix.length === 1 ? byPrefix[0] ?? null : null
}

// A message row's own render id, seen only while that row is drawn. Preferred
// as a jump target because it lands on the ask; `anchor` (the turn's first tool
// row, always in the transcript) is the fallback that also covers history.
const askIds = new Map<string, string>()

/**
 * Which turn the transcript is showing. Every kind of row reports `onScreen` —
 * the ask, each block of the reply, each tool call — so each is mapped to its
 * turn and the earliest turn in the latest burst of reports is the one marked.
 *
 * All of it is plain module state. A render hook may not write `$.state` — the
 * engine denies it, "drawing is pure" — so the marked turn cannot live there;
 * the pane reads the module's value and is redrawn by the snapshot loop below.
 */
/**
 * Rows in the viewport, by their own render id, each holding what it can be
 * looked up by rather than a turn number. A row reports the moment it is
 * drawn, which for the turn in flight is before the maps below have met it;
 * resolving at report time dropped those rows for good and left the marker
 * one turn behind. They are resolved each time the marker is computed instead.
 */
type Seen = { tool?: string; text?: string; at: number }
const visible = new Map<string, Seen>()
let markedN: number | null = null
let turnOfTool = new Map<string, number>()
let turnOfText = new Map<string, number>()
let latestN = 0
/**
 * How long a report stays evidence, measured back from the newest one. A fast
 * scroll unmounts the rows it leaves without ever reporting them off, so "is
 * still in the map" cannot mean "is still on screen" — after a jump to the
 * bottom the marker sat on a card from where the scroll began. Only the latest
 * burst of reports is trusted: a scroll step reports both edges together, and
 * a jump reports the whole new viewport, so the burst is always the truth.
 */
const FRESH_MS = 400

function turnOf(seen: Seen): number | undefined {
  if (seen.tool !== undefined) {
    // A tool id the maps have not met can only be newer than they are.
    return turnOfTool.get(seen.tool) ?? (latestN > 0 ? latestN : undefined)
  }

  return seen.text === undefined ? undefined : turnOfText.get(seen.text)
}

function recompute(): void {
  let latest = 0
  for (const seen of visible.values()) {
    if (seen.at > latest) {
      latest = seen.at
    }
  }
  let top: number | undefined
  let atEnd = false
  for (const [id, seen] of visible) {
    if (seen.at < latest - FRESH_MS) {
      visible.delete(id)
      continue
    }
    const n = turnOf(seen)
    if (n === latestN) {
      atEnd = true
    }
    if (n !== undefined && (top === undefined || n < top)) {
      top = n
    }
  }
  // With the newest turn on screen you are following the live end, and that is
  // the turn to mark — not the tail of the one before it, which is all that
  // "earliest in the viewport" finds the moment a new prompt lands.
  if (atEnd && latestN > 0) {
    top = latestN
  }
  if (top === undefined || top === markedN) {
    return
  }
  markedN = top
}

function track($: EngineInterface, id: string, os: unknown, by: { tool?: string; text?: string }): void {
  if (os === undefined) {
    return
  }
  const at = Date.now()
  if (at >= inducedUntil) {
    // A report nobody asked for means the transcript is moving.
    ticksLeft = FAST_TICKS
    if (waiting !== null) {
      waiting.cancel()
      waiting = null
      step($)
    }
  }
  if (os === null) {
    visible.delete(id)
  } else {
    visible.set(id, { ...by, at })
  }
  recompute()
}

/**
 * The engine answers a row's draw from memory when its props are ones it has
 * seen, so a row coming back to where it was — the bottom of the transcript,
 * after a scroll up and a quick one down — calls no hook and reports nothing.
 * Reports alone therefore cannot say what is on screen now. Invalidating makes
 * every mounted row report afresh, which is the whole truth in one burst; the
 * rows that are gone simply do not answer and age out.
 *
 * It runs only while the pane is open: quickly for a few seconds after the
 * transcript last moved, then once every few seconds as a net for a move that
 * raised no report at all.
 */
const FAST_TICKS = 8
const FAST_MS = 200
const SLOW_MS = 3000
let ticksLeft = 0
let looping = false
let waiting: { cancel: () => void } | null = null
let inducedUntil = 0
/** The card the pane was last scrolled to, so it is moved only on a change. */
let scrolledTo: number | null = null

function step($: EngineInterface): void {
  void $.ui.panes().then(panes => {
    if (!panes.some(pane => pane.id === PANE)) {
      looping = false
      return
    }
    const before = markedN
    inducedUntil = Date.now() + 180
    $.ui.invalidate('ui.render')
    $.clock.after(FAST_MS, () => {
      if (markedN !== before) {
        ticksLeft = FAST_TICKS
      }
      // Out here, not in the draw: keep the marked card inside the pane's own
      // window as well.
      if (markedN !== null && markedN !== scrolledTo) {
        scrolledTo = markedN
        void $.ui.scroll({ to: { key: `t${markedN}` }, in: PANE, block: 'nearest' }).catch(() => undefined)
      }
      if (ticksLeft > 0) {
        ticksLeft -= 1
        step($)
      } else {
        waiting = $.clock.after(SLOW_MS, () => {
          waiting = null
          step($)
        })
      }
    })
  })
}

function loop($: EngineInterface): void {
  if (!looping) {
    looping = true
    step($)
  }
}

function keyOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60)
}

// Rows are derived from the whole transcript. The walk is linear in the
// session, so it is cached and redone only when a turn or a fill changes it.
let cache: { size: number; rows: Row[] } | null = null

// Summaries, by anchor. Written once, read from the store on every load — a
// summarising is the paid part of this mod, and nothing is recomputed.
type Summary = { ask: string; did: string }
let summaries: Record<string, Summary> = {}
let loaded = false

// Auto-fill runs only while the pane is open, so nothing is spent on summaries
// nobody is looking at. Turns arrive one per prompt, already spaced, so each is
// filled as it lands — there is no burst to debounce.
let filling = false
/** Rows per summarising call, so a reply never runs past its own cap. */
const BATCH = 25
/**
 * How many times a fill tried a row and wrote nothing. A row is given up on
 * after GIVE_UP_AFTER, so a model that keeps declining one is not paid for on
 * every draw — but a single failure no longer condemns it, since most are
 * transient: a rate limit, an interrupted turn, a reply that parsed badly.
 */
const tries = new Map<string, number>()
const GIVE_UP_AFTER = 3

function isSpent(key: string): boolean {
  return (tries.get(key) ?? 0) >= GIVE_UP_AFTER
}

function missed(key: string): void {
  tries.set(key, (tries.get(key) ?? 0) + 1)
}
/**
 * The transcript size at the last attempt. A draw happens for many reasons and
 * most change nothing, so a fill that failed must not be retried until there is
 * something new to try it on, rather than on every redraw.
 */
let triedAt = -1
type Spent = { calls: number; input: number; out: number; quota: number }

/**
 * What this session's fills have cost. Kept in the store, not just in memory:
 * a reload empties the module and a running total that resets on every reload
 * is not a running total.
 */
let spent: Spent = { calls: 0, input: 0, out: 0, quota: 0 }

function spentLine(): string {
  return spent.calls === 0
    ? ''
    : `${spent.quota.toFixed(1)}% of 5h · ${k(spent.input)} in / ${k(spent.out)} out · ${spent.calls} call${spent.calls > 1 ? 's' : ''}`
}

const WRITES = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

// `cd x && python train.py` really ran `python train.py`, not `cd`.
// Found the hard way: without stripping the preamble every tally read `cd×N`.
const NOISE = new Set(['cd', 'export', 'source', 'set', 'unset', 'echo'])
const PREFIX = new Set(['timeout', 'nohup', 'sudo', 'env', 'time', 'nice', 'xargs', 'command'])
const KEEP_ARG = new Set(['python', 'python3', 'uv', 'npm', 'npx', 'git', 'gh', 'bash', 'sh', 'cargo', 'go'])

export function verbOf(cmd: string): string | null {
  // Only the first line, and nothing past a heredoc marker: a `python3 - <<EOF`
  // body is data, and tallying words out of it is noise, not signal.
  const line = (cmd.split('\n')[0] ?? '').split('<<')[0] ?? ''
  for (const part of line.split(/&&|\|\||;/)) {
    const words = part.trim().split(/\s+/).filter(Boolean)
    while (words.length > 0 && (PREFIX.has(words[0]!) || words[0]!.includes('=') || /^\d+$/.test(words[0]!))) {
      words.shift()
    }
    const first = words[0]
    if (first === undefined || NOISE.has(first)) {
      continue
    }
    const verb = (first.split('/').pop() ?? first).replace(/^['"`(]+/, '')
    if (verb === '' || !/^[\w.-]+$/.test(verb)) {
      continue
    }
    if (KEEP_ARG.has(verb)) {
      // `git commit` beats `git`; skip flags and their values to find the subcommand.
      const arg = words.slice(1).find(w => !w.startsWith('-') && !w.includes('='))
      if (arg !== undefined) {
        return `${verb} ${arg.split('/').pop()}`
      }
    }

    return verb
  }

  return null
}

// A turn the person did not type: a background task reporting, a slash command,
// the engine's own framing. They open a segment too, but read differently.
const INJECTED = /^\s*<(task-notification|command-name|local-command|system-reminder)/

// A terminal lays out in cells, not code units: CJK, fullwidth forms and most
// emoji take two. Truncating by length overflowed every Chinese headline by
// about double and wrapped it under its own number.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]/u

export function cells(text: string): number {
  let n = 0
  for (const ch of text) {
    n += WIDE.test(ch) ? 2 : 1
  }

  return n
}

/** Flatten to one line and cut it to `n` terminal cells, not `n` characters. */
function head(text: string, n: number): string {
  const flat = text.replace(/<[^>]+>/g, ' ').split(/\s+/).join(' ').trim()
  if (cells(flat) <= n) {
    return flat
  }
  let out = ''
  let used = 0
  for (const ch of flat) {
    const w = WIDE.test(ch) ? 2 : 1
    if (used + w > n - 1) {
      break
    }
    out += ch
    used += w
  }

  return `${out}…`
}

/**
 * The opening and the close of a long prompt. A paste usually comes first and
 * the request after it, so the head alone handed the summariser the pasted
 * text and none of what was being asked — it had nothing to answer and the row
 * stayed raw.
 */
function excerpt(text: string, open: number, close: number): string {
  const flat = text.replace(/<[^>]+>/g, ' ').split(/\s+/).join(' ').trim()

  return flat.length <= open + close ? flat : `${flat.slice(0, open)} … ${flat.slice(-close)}`
}

function tally(items: string[], top: number): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
    .join(', ')
}

type Row = {
  n: number
  ask: string
  isInjected: boolean
  /** What the turn did, deterministically: files, commands, other tools. */
  facts: string[]
  /** Error text as the tool reported it. Never summarized — a model smooths
      "tried four times and failed" into "addressed the issue". */
  errors: string[]
  /** The first tool row of this turn, whose requestId is its tool_use_id. */
  anchor?: string
  /** Stable key for the stored summary; turns are append-only, so `n` holds. */
  key: string
  /** Every tool call of the turn, and the opening of each reply block. */
  toolIds: string[]
  replyKeys: string[]
  /** This turn alone, trimmed — what `complete` is given when only one is missing. */
  body: string
}

/** One row per message you sent, holding what the turns after it actually did. */
export function rowsOf(messages: readonly SessionMessage[]): Row[] {
  const rows: Row[] = []
  let uses: SessionMessage['toolUses'] = []

  const close = () => {
    const row = rows[rows.length - 1]
    if (row === undefined) {
      return
    }
    const files: string[] = []
    const cmds: string[] = []
    const other: string[] = []

    row.anchor = uses[0]?.tool_use_id
    for (const use of uses) {
      if (use.isError === true && row.errors.length < 20) {
        row.errors.push(use.text ?? 'failed')
      }
      if (WRITES.has(use.tool)) {
        const path = (use.input.file_path ?? use.input.notebook_path) as string | undefined
        if (path !== undefined && !files.includes(path)) {
          files.push(path)
        }
      } else if (use.tool === 'Bash') {
        const verb = verbOf((use.input.command as string) ?? '')
        if (verb !== null) {
          cmds.push(verb)
        }
      } else {
        other.push(use.tool.replace(/^mcp__/, ''))
      }
    }

    if (files.length > 0) {
      row.facts.push(`${files.length} file${files.length > 1 ? 's' : ''}: ${files.slice(0, 4).map(f => f.split('/').pop()).join(', ')}`)
    }
    if (cmds.length > 0) {
      row.facts.push(`${cmds.length} cmd: ${tally(cmds, 4)}`)
    }
    if (other.length > 0) {
      row.facts.push(tally(other, 4))
    }
    uses = []
  }

  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() !== '') {
      close()
      rows.push({
        n: rows.length + 1,
        key: `t${rows.length + 1}`,
        ask: m.text,
        isInjected: INJECTED.test(m.text),
        facts: [],
        errors: [],
        body: '',
        toolIds: [],
        replyKeys: [],
      })
    } else if (m.role === 'assistant') {
      uses = [...uses, ...m.toolUses]
      const row = rows[rows.length - 1]
      if (row !== undefined) {
        row.toolIds.push(...m.toolUses.map(u => u.tool_use_id))
        if (m.text.trim() !== '') {
          row.replyKeys.push(keyOf(m.text))
        }
      }
      if (row !== undefined && row.body.length < 6000) {
        // Enough of the turn to summarise it and no more: the reply, then each
        // call by name with a short look at what it ran and whether it failed.
        const calls = m.toolUses
          .map(u => {
            const arg = (u.input.command ?? u.input.file_path ?? u.input.pattern ?? '') as string
            return `  [${u.tool}] ${String(arg).split('\n')[0]?.slice(0, 120) ?? ''}${u.isError === true ? ' → FAILED' : ''}`
          })
          .join('\n')
        row.body += `${m.text.slice(0, 1500)}\n${calls}\n`
      }
    }
  }
  close()

  return rows
}

function rowsCached(messages: readonly SessionMessage[]): Row[] {
  if (cache === null || cache.size !== messages.length) {
    // Every turn, including the ones that only talked: a trajectory with gaps
    // in its numbering is not a trajectory, and a turn that decided something
    // without touching a file is often the one that mattered.
    cache = { size: messages.length, rows: rowsOf(messages) }
    turnOfTool = new Map()
    turnOfText = new Map()
    latestN = cache.rows.length
    for (const row of cache.rows) {
      turnOfText.set(keyOf(row.ask), row.n)
      for (const id of row.toolIds) {
        turnOfTool.set(id, row.n)
      }
      for (const k of row.replyKeys) {
        turnOfText.set(k, row.n)
      }
    }
  }

  return cache.rows
}

/** The single-turn prompt, for `complete`, which sees only what it is given. */
function onePrompt(row: Row, language: string): string {
  return [
    'Below is one turn of a coding session: what the user asked, then what the',
    'assistant replied and which tools it ran.',
    '',
    'Answer with one line and nothing else:',
    `${row.n}|<the ask in up to 10 words>|<what the assistant did, up to 16 words, past tense>`,
    '',
    'Name the concrete thing: the file, the fix, the finding, the number. If the',
    'turn failed or was abandoned, say so plainly — never smooth a failure into',
    'an accomplishment.',
    '',
    `Write both fields in ${language}, whatever language the turn itself is in.`,
    '',
    `ASKED: ${excerpt(row.ask, 160, 400)}`,
    `DID:\n${row.body.slice(0, 5000)}`,
  ].join('\n')
}

/**
 * The asks alone. A prompt is there the moment it is sent, so a row can say
 * what it was for long before it can say what came of it.
 */
function asksPrompt(rows: Row[], language: string): string {
  return [
    'Below are things a user asked in a coding session. For each, say what they',
    'wanted — the point of the ask, not its wording.',
    '',
    'Output one line per item, nothing else. No preamble, no markdown:',
    '<number>|<up to 10 words>',
    '',
    `Write in ${language}, whatever language the ask itself is in.`,
    '',
    ...rows.map(r => `${r.n}. ${excerpt(r.ask, 90, 260)}`),
  ].join('\n')
}

/**
 * Several turns with their replies, for `complete`, which sees only what it is
 * given. Each body is trimmed to share the call's budget.
 */
function batchPrompt(rows: Row[], language: string): string {
  const each = Math.max(300, Math.floor(60000 / Math.max(1, rows.length)))

  return [
    'Below are turns of a coding session: what the user asked, then what the',
    'assistant replied and which tools it ran.',
    '',
    'Output one line per turn, nothing else. No preamble, no markdown:',
    '<number>|<the ask in up to 10 words>|<what the assistant did, up to 16 words, past tense>',
    '',
    'Name the concrete thing: the file, the fix, the finding, the number. If a',
    'turn failed or was abandoned, say so plainly — never smooth a failure into',
    'an accomplishment.',
    '',
    `Write both fields in ${language}, whatever language the turn is in.`,
    '',
    ...rows.map(r => `--- ${r.n}\nASKED: ${excerpt(r.ask, 90, 260)}\nDID: ${r.body.slice(0, each)}`),
  ].join('\n')
}

export const VERBS = ['help', 'fill', 'lang', 'replies', 'close'] as const

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }

  return prev[b.length] ?? 0
}

/**
 * The verb a word meant. Exact first, then an unambiguous prefix, then the
 * nearest within two edits — a command you can only reach by spelling it
 * exactly is a command you have to keep looking up.
 */
export function resolveVerb(word: string): string | null {
  const w = word.toLowerCase()
  if (w === '') {
    return null
  }
  if ((VERBS as readonly string[]).includes(w)) {
    return w
  }
  const byPrefix = VERBS.filter(v => v.startsWith(w))
  if (byPrefix.length === 1) {
    return byPrefix[0] ?? null
  }
  // The other direction too: a word that opens with a verb and then goes wrong
  // (`langauge`, `filll`) is further than two edits but perfectly clear.
  const opensWith = VERBS.find(v => w.startsWith(v))
  if (opensWith !== undefined) {
    return opensWith
  }
  let best: string | null = null
  let bestAt = 3
  for (const v of VERBS) {
    const d = distance(w, v)
    if (d < bestAt) {
      bestAt = d
      best = v
    }
  }

  return best
}

export function parseAsks(text: string): Record<number, string> {
  const out: Record<number, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s*\|\s*(.+?)\s*$/.exec(line)
    if (match !== null) {
      out[Number(match[1])] = match[2]!
    }
  }

  return out
}

export function parseFill(text: string): Record<number, { ask: string; did: string }> {
  const out: Record<number, { ask: string; did: string }> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$/.exec(line)
    if (match !== null) {
      out[Number(match[1])] = { ask: match[2]!, did: match[3]! }
    }
  }

  return out
}

function quotaOf(usage: { rateLimits: readonly { kind: string; percentUsed: number }[] }): number {
  return usage.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed ?? 0
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/**
 * What a row without a reply summary says, or null to say nothing. Only the
 * newest row can still be waiting on a reply, and only a row with a reply can
 * be summarised: a slash command has neither and sat at `waiting…` for good.
 */
export function pendingOf(row: Row, isLast: boolean, isFilling: boolean): string | null {
  if (row.body.trim() !== '') return isFilling ? 'summarising…' : isLast ? 'waiting…' : null
  return isLast ? 'waiting…' : null
}

/** The same rows as text, for a surface that draws no pane. */
function asText(rows: Row[], store: Record<string, Summary>, doReplies: boolean): string {
  return rows
    .map(r => {
      const summary = store[r.key]
      const lines = [`${r.isInjected ? '⏱' : '❯'} ${String(r.n).padStart(3)}  ${head(summary?.ask ?? r.ask, 68)}`]
      const did = summary?.did || (doReplies && summary !== undefined ? pendingOf(r, r.n === rows.length, false) : null)
      if (did) {
        lines.push(`      → ${did}`)
      }
      if (r.facts.length > 0) {
        lines.push(`      ${r.facts.join(' · ')}`)
      }
      for (const err of r.errors.slice(0, 2)) {
        lines.push(`      ⚠ ${head(err, 76)}`)
      }

      return lines.join('\n')
    })
    .join('\n\n')
}

/**
 * Summarise every turn that has none, and store the result.
 * Resolves a line saying what it cost, or '' when there was nothing to do.
 */
export function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size))
  }

  return out
}

const WAVE = 4

/** Runs `work` over the chunks, `WAVE` at a time, so a backlog cannot open a call per chunk at once. */
async function inWaves<T>(chunks: T[][], work: (chunk: T[]) => Promise<void>): Promise<void> {
  for (const wave of chunksOf(chunks, WAVE)) {
    await Promise.all(wave.map(work))
  }
}

async function runFill(
  $: EngineInterface,
  rows: Row[],
  storeKey: string,
  language: string,
  size: number,
  doReplies: boolean,
  /** A fill you asked for retries whatever an automatic one gave up on. */
  isForced = false,
): Promise<string> {
  if (isForced) {
    tries.clear()
  } else if (size === triedAt) {
    return ''
  }
  // A prompt is there at once and a reply is not, so the ask is always written
  // first and the reply side upgrades it later. Waiting for the reply to write
  // either is what left a new row showing its raw prompt for a whole turn.
  const asksOnly = rows.filter(r => !isSpent(r.key) && summaries[r.key] === undefined)
  // Recomputed after the asks are written: a row the ask pass just created is
  // one this pass should upgrade in the same run. Taking it before meant the
  // list was always empty on a first fill, and every row sat at `waiting…`
  // until something else happened to trigger another.
  // With replies off this is always empty, so the loop below has nothing to
  // iterate and `$.model.complete` is never reached for a reply.
  const upgradable = () =>
    doReplies
      ? rows.filter(r => !isSpent(r.key) && summaries[r.key]?.did === '' && r.body.trim() !== '')
      : []
  if (asksOnly.length === 0 && upgradable().length === 0) {
    return ''
  }
  if (filling) {
    return ''
  }
  filling = true
  triedAt = size
  let isRetried = false
  const startedAt = await $.clock.now()
  const before = quotaOf(await $.session.usage())
  try {
    let written = 0
    const usages: ({ input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | undefined)[] = []

    // One call writing a hundred lines made a first open wait for the last
    // line before showing the first. The backlog goes out in chunks, a few at
    // a time and the newest first, and each chunk is drawn as it lands.
    // A call that came back with nothing is tried again on the next draw
    // rather than at the next turn; `missed` bounds how often.
    // A failure says nothing: the card already falls back to the raw prompt.
    const fail = (chunk: Row[]) => {
      for (const row of chunk) {
        missed(row.key)
      }
      isRetried = true
    }
    const land = async () => {
      await $.store.set(storeKey, summaries)
      cache = null
      $.ui.invalidate('ui.render')
    }

    // The asks go first: they are short, they need no reply, and they are
    // what turns a raw prompt into a line you can read while the turn runs.
    await inWaves(chunksOf([...asksOnly].reverse(), BATCH), async chunk => {
      const reply = await $.model.complete({
        model: 'haiku',
        effort: 'low',
        // A floor well above one line: a prompt holding three questions drew
        // three lines, ran past a cap sized for one, and came back as no reply.
        maxTokens: 200 + chunk.length * 30,
        prompt: asksPrompt(chunk, language),
      })
      if (!reply.isAnswered) {
        fail(chunk)

        return
      }
      usages.push(reply.usage)
      const parsed = parseAsks(reply.text)
      for (const row of chunk) {
        const got = parsed[row.n]
        if (got === undefined) {
          missed(row.key)
        } else {
          summaries[row.key] = { ask: got, did: '' }
          written += 1
        }
      }
      await land()
    })

    // Every batch goes to `complete`: it takes an explicit output cap, and a
    // fork does not. A fork answering 61 rows ran past the default cap, lost
    // every line after it, counted those rows as failures and re-read the
    // whole prefix to fail again — 33 calls and two million tokens for a
    // timeline that stayed at `waiting…`. `complete` is also what the measured
    // cost argued for: 3.8k tokens against a fork's 414k.
    const full = upgradable()
    await inWaves(chunksOf([...full].reverse(), BATCH), async chunk => {
      const reply = await $.model.complete({
        model: 'haiku',
        effort: 'low',
        maxTokens: 200 + chunk.length * 60,
        prompt: chunk.length === 1 && chunk[0] !== undefined
          ? onePrompt(chunk[0], language)
          : batchPrompt(chunk, language),
      })
      if (!reply.isAnswered) {
        fail(chunk)

        return
      }
      usages.push(reply.usage)
      const parsed = parseFill(reply.text)
      for (const row of chunk) {
        const got = parsed[row.n]
        if (got === undefined) {
          missed(row.key)
        } else {
          summaries[row.key] = got
          written += 1
        }
      }
      await land()
    })

    if (written === 0) {
      return 'nothing to summarise yet'
    }
    await $.store.set(storeKey, summaries)
    cache = null

    const used = usages.reduce((n, u) => n + (u === undefined ? 0 : u.cache_read_input_tokens + u.input_tokens), 0)
    const out = usages.reduce((n, u) => n + (u?.output_tokens ?? 0), 0)
    spent.calls += usages.length
    spent.input += used
    spent.out += out
    // The quota windows move in tenths of a percent, so the difference across
    // the call is what this summary actually took out of the subscription.
    const quota = Math.max(0, quotaOf(await $.session.usage()) - before)
    spent.quota += quota
    await $.store.set(`${storeKey}:spent`, spent)
    $.ui.invalidate('ui.render')

    const seconds = ((await $.clock.now()) - startedAt) / 1000
    const asked = full.length + asksOnly.length
    const partial = asksOnly.length > 0 ? `, ${asksOnly.length} ask-only` : ''

    return `summarised ${written} of ${asked} in ${seconds.toFixed(1)}s${partial}`
      + ` · ${k(used)} in, ${k(out)} out`
      + ` · ${quota.toFixed(1)}% of the 5h window`
  } finally {
    filling = false
    if (isRetried) {
      triedAt = -1
      $.ui.invalidate('ui.render')
    }
  }
}

let sessionKey: string | null = null

// The theme has no warm fill of its own, so the marked card takes a tint of
// the accent picked by theme name; any other theme keeps the theme's own key.
let tint = 'userMessageBackground'
let isTinted = false

// `auto` does not say which way it resolved. The terminal's COLORFGBG does
// ("fg;bg", the engine's own fallback rule); without it the theme's key stays.
export function tintOf(theme: string, colorfgbg: string | undefined): string {
  let mode = theme
  if (theme === 'auto') {
    const bg = Number(colorfgbg?.split(';').at(-1) || NaN)
    mode = !Number.isInteger(bg) || bg < 0 || bg > 15 ? '' : bg <= 6 || bg === 8 ? 'dark' : 'light'
  }
  if (mode.includes('ansi')) return 'userMessageBackground'
  if (mode.startsWith('light')) return 'rgb(252,236,226)'
  if (mode.startsWith('dark')) return 'rgb(66,46,38)'
  return 'userMessageBackground'
}

async function loadTint($: EngineInterface): Promise<void> {
  if (isTinted) return
  isTinted = true
  const theme = String((await $.config.list()).find(row => row.key === 'theme')?.value ?? '')
  tint = tintOf(theme, await $.env.get('COLORFGBG'))
}

async function loadStore($: EngineInterface, language: string): Promise<string> {
  // Asked once: the pane is drawn often and the session does not change.
  sessionKey ??= `timeline:${await $.session.id()}`
  const storeKey = sessionKey
  if (!loaded) {
    spent = ((await $.store.get(`${storeKey}:spent`)) as Spent | undefined)
      ?? { calls: 0, input: 0, out: 0, quota: 0 }
    const stored = ((await $.store.get(storeKey)) as Record<string, unknown>) ?? {}
    // v0 stored one string per turn. Those lack the ask side, so drop them and
    // let a fill write both — a refill is one call, not one per turn.
    // Summaries are written in one language; changing it in /config reloads
    // the module, and the ones already stored no longer match, so they go.
    const was = await $.store.get(`${storeKey}:language`)
    summaries = was === language
      ? (Object.fromEntries(
          Object.entries(stored).filter(([, v]) => typeof v === 'object' && v !== null),
        ) as Record<string, Summary>)
      : {}
    if (was !== language) {
      await $.store.set(`${storeKey}:language`, language)
    }
    loaded = true
  }

  return storeKey
}

export const register: Register = (on, options) => {
  const language = String(options.language ?? 'English')
  // Off: the reply pass is never built and never called. The ask pass still
  // runs, so a row still reads as a line rather than a raw prompt.
  const doReplies = options.replySummaries !== false

  // A pane is drawn when the engine asks, and new messages are not an ask.
  // Without this the pane sits on whatever the last draw found.
  // A prompt lands at turn.start, and the pane was only redrawn at
  // turn.complete — so a new row sat showing its raw text for the whole turn.
  // /theme is a slash command and starts no turn, so the tint is re-read as
  // the row changes rather than at the next prompt.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    isTinted = false
    $.ui.invalidate('ui.render')

    return result
  })

  on('turn.start', ($, e, next) => {
    cache = null
    // The theme may have changed since the last turn; read it again.
    isTinted = false
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    cache = null
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const key = keyOf(e.props.text)
    if (key === '') {
      return next(e)
    }
    askIds.set(key, e.requestId)

    track($, e.requestId, e.props.onScreen, { text: key })

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    track($, e.requestId, e.props.onScreen, { text: keyOf(e.props.text) })

    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    track($, e.requestId, e.props.onScreen, { tool: e.props.tool_use_id })

    return next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const id = e.props.calls.find(c => c.tool_use_id !== undefined)?.tool_use_id
    if (id !== undefined) {
      track($, e.requestId, e.props.onScreen, { tool: id })
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'timeline',
      description: 'What this session did — `fill`, `lang`, `replies on|off`, `close`',
    })

    return next(e)
  })

  on('command.run', { command: 'timeline' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    const word = arg.split(/\s+/)[0] ?? ''
    const rest = arg.slice(word.length).trim()
    const verb = resolveVerb(word)

    if (verb === 'help' || (word !== '' && verb === null)) {
      return {
        text: [
          'timeline — what this session actually did, turn by turn.',
          '',
          '  /timeline                 open the pane (or print it where none can be drawn)',
          '  /timeline fill            summarise everything missing now',
          '  /timeline lang <name>     ' + LANGUAGES.join(' | '),
          '  /timeline replies on|off  write the reply side, or only the ask',
          '  /timeline close',
          '',
          `  now: ${language} · replies ${doReplies ? 'on' : 'off'}`,
          '  a near miss is accepted: /timeline fil, /timeline lng, /timeline rep',
        ].join('\n'),
      }
    }

    // `/config` lists every mod's options in one place, which is where they
    // belong; a mod with its own command should also answer for its own
    // setting. Both write the same row, so there is one source of truth.
    if (verb === 'lang') {
      const want = rest
      if (want === '') {
        return {
          text: `timeline: summaries are in ${language}.`
            + `\n  /timeline lang <${LANGUAGES.join(' | ')}>`,
        }
      }
      const picked = resolveLanguage(want)
      if (picked === null) {
        return { text: `timeline: no such language. One of: ${LANGUAGES.join(', ')}` }
      }
      if (picked === language) {
        return { text: `timeline: already ${picked}.` }
      }
      const done = await $.config.set({ key: 'timeline.language', value: picked })
      if ('deny' in done) {
        return { text: `timeline: could not set it (${String(done.deny)})` }
      }

      // The change reloads the mod; the stored summaries no longer match the
      // language and are dropped on that load, so the next draw rewrites them.
      return { text: `timeline: summaries will be written in ${picked} — open the pane to rewrite them.` }
    }

    if (verb === 'replies') {
      const want = rest.toLowerCase()
      if (want === '') {
        return {
          text: `timeline: reply summaries are ${doReplies ? 'on' : 'off'}.`
            + '\n  /timeline replies <on | off>'
            + (doReplies ? '' : '\n  off: no call is made for the reply side at all.'),
        }
      }
      if (want !== 'on' && want !== 'off') {
        return { text: 'timeline: say `on` or `off`.' }
      }
      const wantOn = want === 'on'
      if (wantOn === doReplies) {
        return { text: `timeline: already ${want}.` }
      }
      const done = await $.config.set({ key: 'timeline.replySummaries', value: wantOn })
      if ('deny' in done) {
        return { text: `timeline: could not set it (${String(done.deny)})` }
      }

      return {
        text: wantOn
          ? 'timeline: reply summaries on — open the pane to fill them in.'
          : 'timeline: reply summaries off. Nothing is called for them, and the rows you have are kept.',
      }
    }

    if (verb === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'timeline: closed' }
    }

    const messages = await $.session.messages()
    if ('deny' in messages) {
      return { text: `timeline: cannot read this session (${messages.deny})` }
    }
    const rows = rowsCached(messages)
    const storeKey = await loadStore($, language)

    if (verb === 'fill') {
      const line = await runFill($, rows, storeKey, language, messages.length, doReplies, true)

      const total = spent.calls > 0 ? ` Total so far: ${spentLine()}` : ''

      return { text: `timeline: ${line === '' ? 'every turn already has a summary.' : line}${total}` }
    }

    if (rows.length === 0) {
      return { text: 'timeline: nothing recorded yet.' }
    }

    const opened = await $.ui.open({ id: PANE, title: 'Timeline' })
    if (opened.isPlaced) {
      // Opening it is the signal that someone wants to read it: catch up on
      // whatever accumulated while it was closed.
      const line = await runFill($, rows, storeKey, language, messages.length, doReplies)

      return { text: line === '' ? 'timeline: pane opened' : `timeline: ${line}` }
    }
    // No pane here: Remote Control and the VS Code extension attach no pane
    // surface (anthropics/claude-code#99217, #99045), and a narrow terminal
    // seats none. Say which, and print it rather than report a pane nobody
    // can see.
    return {
      text: `timeline: this surface draws no pane (${opened.reason})\n\n${asText(rows, summaries, doReplies)}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // A reload empties the module's own variables while the store keeps its
    // summaries, and a draw can be the first thing to run after one — so the
    // drawing loads them itself rather than trusting a command to have run.
    const storeKey = await loadStore($, language)
    await loadTint($)
    // The transcript is fetched only when a turn or a fill has changed it. A
    // redraw because the marker moved reuses the rows it already has, so
    // scrolling does not pull the whole session across on every step.
    let rows: Row[]
    let size: number
    if (cache === null) {
      const messages = await $.session.messages()
      if ('deny' in messages) {
        return <Text dimColor>cannot read this session</Text>
      }
      rows = rowsCached(messages)
      size = messages.length
    } else {
      rows = cache.rows
      size = cache.size
    }
    // The maps may just have caught up with rows that reported before them.
    recompute()
    loop($)
    const nowAt = markedN
    const width = Math.max(24, (e.viewport?.columns ?? 40) - 6)
    // What is left to write, counting a row that has only its ask: the trigger
    // below and the footer both read this, and counting only rows with nothing
    // at all meant a half-written row never asked for its other half.
    const unsummarised = rows.filter(
      r => summaries[r.key] === undefined
        || (doReplies && summaries[r.key]?.did === '' && r.body.trim() !== ''),
    ).length

    // Drawing the pane is the signal that someone is reading it, and the only
    // one that holds across a reload, a reopen and a new turn alike. The fill
    // is not awaited: the tree goes back now with the asks as written, and the
    // summaries land on the redraw its own invalidate causes. `filling` and
    // the missing count bound it — once nothing is missing, no call runs.
    if (unsummarised > 0 && !filling) {
      void runFill($, rows, storeKey, language, size, doReplies)
    }

    return (
      <Box flexDirection="column" paddingRight={1}>
        {rows.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {rows.map(row => {
          const id = askIds.get(row.ask.replace(/\s+/g, ' ').trim().slice(0, 60)) ?? row.anchor
          const summary = summaries[row.key]
          const mark = `${row.isInjected ? '⏱' : '❯'} ${row.n}`
          const title = summary?.ask ?? row.ask
          // The number carries the accent and the ask carries the default tone,
          // so a row reads as a label and a title rather than one grey string.
          // A Button takes a plain string, so the number sits beside it: short
          // and fixed, it cannot wrap and push the ask under itself.
          const askText = head(title, width - cells(mark) - 3)
          const did = summary?.did
            || (doReplies && summary !== undefined ? pendingOf(row, row.n === rows.length, filling) : null)

          return (
            <Box
              key={`t${row.n}`}
              flexDirection="column"
              marginTop={1}
              paddingX={1}
              borderStyle="round"
              borderColor={row.n === nowAt ? 'claude' : 'promptBorder'}
              borderDimColor={row.n !== nowAt}
              // The one card you are at takes the fill the transcript gives
              // your own prompts — a theme key, so it follows the theme. Only
              // that card: a fill on every card marks nothing.
              backgroundColor={row.n === nowAt ? tint : undefined}
            >
              <Box flexDirection="row">
                {/* A raw prompt can measure wider than `cells` counted it; held
                    at its own width, the number is not what gives way. */}
                <Box flexShrink={0}>
                  <Text color={row.isInjected ? undefined : 'claude'} dimColor={row.isInjected} bold>
                    {mark}
                    {'  '}
                  </Text>
                </Box>
                {id === undefined ? (
                  <Text wrap="truncate-end" dimColor={row.isInjected}>{askText}</Text>
                ) : (
                  <Button
                    plain
                    key={`j${row.n}`}
                    label={askText}
                    dimColor={row.isInjected}
                    onPress={() => {
                      void $.ui.scroll({ to: { requestId: id }, block: 'start' })
                    }}
                  />
                )}
              </Box>
              {did !== null && (
                // An ask-only row is written the moment the prompt lands and
                // upgraded when the reply exists. A bare arrow reads as broken,
                // so a row still waiting says which wait it is in: a call is
                // running, or there is nothing to run it on yet.
                <Text wrap="wrap" dimColor={!summary?.did || row.isInjected}>
                  {'  → '}
                  {did}
                </Text>
              )}
              {row.facts.length > 0 && <Text dimColor>{'  '}{row.facts.join(' · ')}</Text>}
              {row.errors.slice(0, 2).map((err, i) => (
                <Text key={`t${row.n}e${i}`} color="error" wrap="wrap">
                  {'  ⚠ '}
                  {head(err, width)}
                </Text>
              ))}
              {row.errors.length > 2 && (
                <Text color="error">{'  ⚠ '}…and {row.errors.length - 2} more</Text>
              )}
            </Box>
          )
        })}
        {/* The count sits under the rows: the newest turn is at the foot of
            the list, so that is where the eye already is. What the summaries
            cost is not shown here; `/timeline fill` reports it on request. */}
        <Text dimColor>
          {'\n'}
          {rows.length} turns
          {unsummarised > 0 ? ` · ${unsummarised} to summarise` : ''}
        </Text>
      </Box>
    )
  })
}

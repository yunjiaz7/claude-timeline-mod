import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const PANE = 'timeline'
const LANGUAGES = ['English', 'Chinese', 'Japanese', 'Spanish', 'French', 'German'] as const
// Codes, and each language's own name — what the options were called before
// they were English, so a setting saved then still resolves.
const LANG_ALIAS: Record<string, string> = {
  en: 'English', zh: 'Chinese', cn: 'Chinese', '\u4e2d\u6587': 'Chinese',
  ja: 'Japanese', jp: 'Japanese', '\u65e5\u672c\u8a9e': 'Japanese',
  es: 'Spanish', 'espa\u00f1ol': 'Spanish',
  fr: 'French', 'fran\u00e7ais': 'French',
  de: 'German', deutsch: 'German',
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
  // The start of a name, English or the language's own (`esp`, `deu`).
  const byPrefix = new Set([
    ...LANGUAGES.filter(l => l.toLowerCase().startsWith(w)),
    ...Object.entries(LANG_ALIAS).filter(([k]) => k.length > 2 && k.startsWith(w)).map(([, v]) => v),
  ])

  return byPrefix.size === 1 ? [...byPrefix][0] ?? null : null
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
type Seen = { tool?: string; text?: string; isAsk?: boolean; at: number }
const visible = new Map<string, Seen>()
let markedN: number | null = null
/**
 * A counter the pane reads, so that bumping it redraws the pane and nothing
 * else. Invalidating `ui.render` redraws every transcript row as well — and
 * empties the engine's cache of them — so it is kept for the one thing that
 * needs it: making the rows report where they are.
 */
const drawAtom = atom({ plugin: 'timeline', key: 'draw' } as const, 0)
/** The mark as the pane last drew it. */
let drawnMark: number | null = null
/** Whether the pane is open: set by its own draw, cleared by `ui.close`. */
let isOpen = false

function redrawPane($: EngineInterface): void {
  // A write the engine refuses (one made while a drawing is running) falls
  // back to the broad redraw, so the pane is never left stale.
  void update($, drawAtom, n => n + 1).catch(() => $.ui.invalidate('ui.render'))
}
/**
 * Each row's last `onScreen`, as text. A redraw the loop asked for reports
 * the same value again; a different one means the transcript moved.
 */
const lastSeen = new Map<string, string>()
/** Whether a row reported a move since the loop's last tick. */
let hasMoved = false
/**
 * Whether a message row reported text the rows do not hold: the transcript
 * grew since they were read. At `turn.start` the new prompt may not be stored
 * yet, so a pane drawn then lacks it; the loop rereads on its next tick.
 */
let isStale = false
/**
 * Whether the newest turn was among the rows last reported. Then the mark is
 * the newest card whatever else is on screen, so a sweep could not change it:
 * the loop skips them, which is most of the time — sitting at the bottom, and
 * while a reply streams in. A scroll away reports by itself and clears this.
 */
let isAtEnd = false
let turnOfTool = new Map<string, number>()
let turnOfText = new Map<string, number>()
/** Texts more than one turn carries, with the turns that carry each. */
let sharedKeys = new Map<string, number[]>()
/** The summary key of each turn, by number. */
let keyByN: string[] = []
/**
 * Where a duplicate ask's own row is, by its summary key. Its text names
 * several turns; the rows reporting in the same burst say which of them it is.
 */
const askIdByKey = new Map<string, string>()

/** Of `candidates`, the turn nearest the middle of `around`, or undefined with no evidence. */
export function nearest(candidates: readonly number[], around: readonly number[]): number | undefined {
  if (around.length === 0) {
    return undefined
  }
  const sorted = [...around].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)]!
  let best: number | undefined
  for (const n of candidates) {
    if (best === undefined || Math.abs(n - mid) < Math.abs(best - mid)) {
      best = n
    }
  }

  return best
}
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
  const known: number[] = []
  const unsure: [string, Seen][] = []
  for (const [id, seen] of visible) {
    if (seen.at < latest - FRESH_MS) {
      visible.delete(id)
      continue
    }
    const n = turnOf(seen)
    if (n !== undefined) {
      known.push(n)
    } else if (seen.text !== undefined && sharedKeys.has(seen.text)) {
      unsure.push([id, seen])
    }
  }
  // Placed by the rows around them; with nothing around them that can be
  // placed, the latest turn with that text, as it was before duplicates were
  // told apart — but that guess is not kept as a jump target.
  const placed = [...known]
  for (const [id, seen] of unsure) {
    const candidates = sharedKeys.get(seen.text!)!
    const n = nearest(candidates, placed)
    if (n === undefined) {
      known.push(Math.max(...candidates))
      continue
    }
    known.push(n)
    const key = keyByN[n - 1]
    if (seen.isAsk && key !== undefined) {
      askIdByKey.set(key, id)
    }
  }
  for (const n of known) {
    if (n === latestN) {
      atEnd = true
    }
    if (top === undefined || n < top) {
      top = n
    }
  }
  // With the newest turn on screen you are following the live end, and that is
  // the turn to mark — not the tail of the one before it, which is all that
  // "earliest in the viewport" finds the moment a new prompt lands.
  isAtEnd = atEnd && latestN > 0
  if (isAtEnd) {
    top = latestN
  }
  if (top === undefined || top === markedN) {
    return
  }
  markedN = top
}

function track($: EngineInterface, id: string, os: unknown, by: { tool?: string; text?: string; isAsk?: boolean }): void {
  if (os === undefined) {
    return
  }
  const at = Date.now()
  const was = lastSeen.get(id)
  const now = JSON.stringify(os)
  if (lastSeen.size > 5000) {
    lastSeen.clear()
  }
  lastSeen.set(id, now)
  if (was !== now) {
    // A row that reports a new place means the transcript is moving.
    hasMoved = true
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
const FAST_TICKS = 3
const FAST_MS = 200
const SLOW_MS = 3000
let ticksLeft = 0
let looping = false
let waiting: { cancel: () => void } | null = null
/** The card the pane was last scrolled to, so it is moved only on a change. */
let scrolledTo: number | null = null

function step($: EngineInterface): void {
  {
    if (!isOpen) {
      looping = false
      return
    }
    const before = markedN
    // While the transcript moves the rows report on their own, so the loop
    // only asks for a full redraw when none did: after a move stops, and as
    // the slow net for a move that raised no report at all — and never while
    // the newest turn is on screen, where the mark cannot be anything else.
    if (!hasMoved && !isAtEnd) {
      $.ui.invalidate('ui.render')
    }
    hasMoved = false
    $.clock.after(FAST_MS, () => {
      if (markedN !== before) {
        ticksLeft = FAST_TICKS
      }
      if (isStale) {
        isStale = false
        cache = null
        redrawPane($)
      }
      // Out here, not in the draw: keep the marked card inside the pane's own
      // window as well. Moving the window redraws the pane by itself, so the
      // pane is asked for a redraw only if that did not already show the mark.
      if (markedN !== null && markedN !== scrolledTo && !isFinding) {
        scrolledTo = markedN
        void $.ui.scroll({ to: { key: `t${markedN}` }, in: PANE, block: 'nearest' }).catch(() => undefined)
      } else if (markedN !== null && markedN !== scrolledTo && matches === null) {
        // Under the box the cards are scrolled here, so following is too.
        scrolledTo = markedN
        const to = fitTop(heights, findTop, markedN - 1, paneRows - HEAD_ROWS)
        if (to !== findTop) {
          findTop = to
          redrawPane($)
          keepRing($)
        }
      }
      $.clock.after(60, () => {
        if (drawnMark !== markedN) {
          redrawPane($)
        }
      })
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
  }
}

function loop($: EngineInterface): void {
  if (!looping) {
    looping = true
    step($)
  }
}

export function keyOf(text: string): string {
  // Called on every report of a message row, so a long paste is cut before it
  // is normalised; the full text is used only when its head is mostly space.
  const key = text.slice(0, 600).replace(/\s+/g, ' ').trim().slice(0, 61)
  if (key.length > 60 || text.length <= 600) {
    return key.slice(0, 60)
  }

  return text.replace(/\s+/g, ' ').trim().slice(0, 60)
}

// Rows are derived from the whole transcript. The walk is linear in the
// session, so it is cached and redone only when a turn or a fill changes it.
let cache: { tail: string; rows: Row[] } | null = null

/**
 * What the transcript looks like at its two ends. The session hands over at
 * most its newest 4096 messages, so past that the count stops changing while
 * the transcript still grows: a gate on the count stopped every fill for good.
 * Both ends move as the window slides; a false "changed" costs a no-op fill.
 */
export function tailOf(messages: readonly SessionMessage[]): string {
  const first = messages[0]
  const last = messages[messages.length - 1]

  return [
    messages.length,
    first?.text.length ?? 0,
    last?.role ?? '',
    last?.text.length ?? 0,
    last?.toolUses.length ?? 0,
    last?.toolUses.at(-1)?.tool_use_id ?? '',
  ].join('|')
}

// Summaries, by anchor. Written once, read from the store on every load — a
// summarising is the paid part of this mod, and nothing is recomputed.
type Summary = { ask: string; did: string }
let summaries: Record<string, Summary> = {}
let loaded = false

// Auto-fill runs only while the pane is open, so nothing is spent on summaries
// nobody is looking at. Turns arrive one per prompt, already spaced, so each is
// filled as it lands — there is no burst to debounce.
let filling = false
// Only a turn that is running can still produce a reply. Without this the
// newest row said `waiting…` after a slash command, which never gets one.
let isRunning = false
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
/** Calls that failed in a row; automatic fills stop at the max until a turn starts. */
let callFailures = 0
const CALL_FAILURES_MAX = 3

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
let triedAt = ''
type Side = { calls: number; input: number; out: number }
// `asks` and `replies` came later than the totals: a session summarised before
// them has totals larger than the two sides, and the rest is shown as earlier.
type Spent = Side & { quota: number; asks?: Side; replies?: Side; finds?: Side }

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

// Haiku's API list price per million tokens. A subscription pays in quota, not
// dollars, so this is only a scale for comparing the two sides.
const USD_IN = 1
const USD_OUT = 5

/** The answer to `/timeline cost`: each side of the summaries, then how to stop the larger one. */
export function costText(total: Spent, doReplies: boolean): string {
  if (total.calls === 0) {
    return 'timeline cost: nothing spent in this session yet.'
  }
  const none: Side = { calls: 0, input: 0, out: 0 }
  const asks = total.asks ?? none
  const replies = total.replies ?? none
  const finds = total.finds ?? none
  const earlier: Side = {
    calls: total.calls - asks.calls - replies.calls - finds.calls,
    input: total.input - asks.input - replies.input - finds.input,
    out: total.out - asks.out - replies.out - finds.out,
  }
  const line = (name: string, side: Side, note = '') =>
    `  ${name.padEnd(9)}${String(side.calls).padStart(4)} call${side.calls === 1 ? ' ' : 's'} · ${k(side.input)} in / ${k(side.out)} out`
    + ` · ≈ $${((side.input * USD_IN + side.out * USD_OUT) / 1e6).toFixed(3)}${note}`

  return [
    'timeline cost — what the summaries in this session took (Haiku)',
    '',
    line('prompts', asks, '   summarising what you asked'),
    line('replies', replies, '   summarising what Claude did'),
    ...(finds.calls > 0 ? [line('searches', finds, '   /timeline find')] : []),
    ...(earlier.calls > 0 ? [line('earlier', earlier, '   before the two were counted apart')] : []),
    '',
    `  ${total.quota.toFixed(1)}% of the 5h window in all. Dollars are Haiku's API list price, for scale:`,
    '  a subscription pays in that window, not in dollars.',
    '',
    doReplies
      ? '  Replies cost more because they read Claude\'s output. `/timeline replies off`\n  stops them — nothing is spent reading output, and prompts are still summarised.'
      : '  Replies are off: nothing is spent reading Claude\'s output. `/timeline replies on` brings them back.',
  ].join('\n')
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

// The search box. Module state: a reload closes it, which is what a reload
// of a search nobody is typing into should do.
// Open by default: the box is part of the pane, and `/timeline find` puts it
// away for the session.
let isFinding = true
let query = ''
/** Row numbers, best first; null before a search has answered. */
let matches: number[] | null = null
let isSearching = false
// While the box is open the pane's window never moves: the box is the head
// of the tree and the cards under it are scrolled here, by leaving out the
// ones above `findTop`. A box that chased the window's offset was drawn one
// frame late on every tick and flickered.
let findTop = 0
// The keyboard's ring. Every line of a card is a Button, so the ring would
// stop on each line; it is steered to stop once per card, on the title.
let focusedKey: string | null = null
/** The card the keys have chosen. Set as the key is pressed: the ring itself
 *  lands a drawing later, and a second press must not start from the old card. */
let selected: number | null = null
/** The numbers of the cards shown, in the order drawn. */
let shownOrder: number[] = []
let isResetting = false
let isPaneFocused = false

/**
 * The engine's ring keeps its place in the list, not its card: when the cards
 * above it are scrolled away it ends up on a different one. After the cards
 * move it is put back on the chosen card, or on the search box once that card
 * is no longer drawn. Only while the pane holds the keyboard — asking for the
 * ring otherwise would take the keyboard from the prompt.
 */
function keepRing($: EngineInterface): void {
  if (!isPaneFocused || selected === null) {
    return
  }
  const at = shownOrder.indexOf(selected)
  const isDrawn = at >= findTop && at < findTop + drawnCount
  const key = isDrawn ? `j${selected}` : 'find'
  if (!isDrawn) {
    selected = null
  }
  $.clock.after(60, () => {
    void $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
  })
}

/** The card a line's key belongs to: `j12`, `d12.0` and `f12.1` are card 12's. */
export function cardOf(key: string | null | undefined): number | null {
  const match = /^[jdf](\d+)(\.\d+)?$/.exec(key ?? '')

  return match === null ? null : Number(match[1])
}

/** Rows each drawn card takes, and the rows the pane shows: what following needs. */
let heights: number[] = []
let paneRows = 40
/**
 * How many cards are drawn under the box: the ones that fit, and one more so
 * the last row of the window is never empty. The window does not move while
 * the box is up, so a card past these could not be seen.
 */
let drawnCount = 40

/**
 * The furthest the first drawn card may go: the one from which the cards to
 * the end just fill the window, so the last card stays at the bottom as it
 * does when the pane scrolls by itself, instead of rising to the top over
 * empty space.
 */
export function lastTop(rowsOf: readonly number[], room: number): number {
  let used = 0
  for (let i = rowsOf.length - 1; i >= 0; i -= 1) {
    used += rowsOf[i] ?? 0
    if (used > room) {
      return Math.min(rowsOf.length - 1, i + 1)
    }
  }

  return 0
}

export function fitCount(rowsOf: readonly number[], top: number, room: number): number {
  let used = 0
  let n = 0
  for (let i = top; i < rowsOf.length && used <= room; i += 1) {
    used += rowsOf[i] ?? 0
    n += 1
  }

  return n + 1
}

/** The usage line, the box, its status, its hint and the gap above the first card. */
const HEAD_ROWS = 7

/**
 * The first card to draw so that card `at` is inside `room` rows: unchanged
 * when it already is, as a window's `nearest` scroll would leave it.
 */
export function fitTop(rowsOf: readonly number[], top: number, at: number, room: number): number {
  if (at < top) {
    return at
  }
  let from = top
  let used = 0
  for (let i = from; i <= at; i += 1) {
    used += rowsOf[i] ?? 0
  }
  while (used > room && from < at) {
    used -= rowsOf[from] ?? 0
    from += 1
  }

  return from
}

/**
 * One call: every turn as a line, and the thing being looked for. The model
 * matches on meaning, which is the point — a summary rarely holds the word
 * the person remembers.
 */
/** About 100k tokens of turns: past that each excerpt is cut to fit. */
const FIND_BUDGET = 300_000

function findPrompt(rows: Row[], store: Record<string, Summary>, wanted: string): string {
  // A normal session fits as it is; only a very long one has its excerpts cut.
  const each = Math.max(40, Math.min(200, Math.floor(FIND_BUDGET / Math.max(1, rows.length)) - 80))
  return [
    'Below are the turns of a coding session, one per line: its number, what',
    'the user asked, and what the assistant did.',
    '',
    'Someone is looking for a turn and describes it from memory. Pick the turns',
    'that match what they mean, even when the words differ or the language does.',
    '',
    'Answer with the numbers only, best match first, comma-separated, at most 8.',
    'If nothing matches, answer: none',
    '',
    `LOOKING FOR: ${wanted.slice(0, 400)}`,
    '',
    ...rows.map(r => {
      const summary = store[r.key]
      const did = summary?.did ? ` => ${summary.did}` : ''

      return `${r.n}. ${summary?.ask ?? ''} | ${excerpt(r.ask, Math.ceil(each * 0.4), Math.floor(each * 0.6))}${did}`
    }),
  ].join('\n')
}

/** The numbers in a find reply, in the order given, each once and within `1..max`. */
export function parseFind(text: string, max: number): number[] {
  const out: number[] = []
  for (const found of text.match(/\d+/g) ?? []) {
    const n = Number(found)
    if (n >= 1 && n <= max && !out.includes(n)) {
      out.push(n)
    }
  }

  return out.slice(0, 8)
}

function closeFind($: EngineInterface): void {
  isFinding = false
  query = ''
  matches = null
  findTop = 0
  redrawPane($)
}

let findAbort: AbortController | null = null

async function runFind($: EngineInterface, rows: Row[], wanted: string): Promise<void> {
  query = wanted.trim()
  findTop = 0
  if (query === '') {
    matches = null
    redrawPane($)

    return
  }
  // The latest search wins: an earlier one still running is cut off, so its
  // answer cannot land over the newer one.
  findAbort?.abort()
  const abort = new AbortController()
  findAbort = abort
  isSearching = true
  redrawPane($)
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 100,
      prompt: findPrompt(rows, summaries, query),
    }, { signal: abort.signal })
    if (findAbort !== abort) {
      return
    }
    matches = reply.isAnswered ? parseFind(reply.text, rows.length) : []
    if (reply.isAnswered && reply.usage !== undefined && sessionKey !== null) {
      const by: Side = {
        calls: 1,
        input: reply.usage.cache_read_input_tokens + reply.usage.input_tokens,
        out: reply.usage.output_tokens,
      }
      const was = spent.finds ?? { calls: 0, input: 0, out: 0 }
      spent = {
        ...spent,
        calls: spent.calls + 1,
        input: spent.input + by.input,
        out: spent.out + by.out,
        finds: { calls: was.calls + 1, input: was.input + by.input, out: was.out + by.out },
      }
      await put($, `${sessionKey}:spent`, spent)
    }
  } finally {
    if (findAbort === abort) {
      findAbort = null
      isSearching = false
      redrawPane($)
    }
  }
}

/** `text` followed by the spaces that bring it to `n` cells. */
function pad(text: string, n: number): string {
  return text + ' '.repeat(Math.max(0, n - cells(text)))
}

/**
 * `text` as lines of at most `n` cells, broken at a space where the line has
 * one late enough and mid-word otherwise (CJK has no spaces to break at).
 */
export function wrapCells(raw: string, n: number): string[] {
  const text = clean(raw)
  const lines: string[] = []
  let line = ''
  let used = 0
  for (const ch of text) {
    const w = WIDE.test(ch) ? 2 : 1
    if (used + w > n) {
      const at = line.lastIndexOf(' ')
      if (ch !== ' ' && at > line.length / 2) {
        lines.push(line.slice(0, at))
        line = line.slice(at + 1)
        used = cells(line)
      } else {
        lines.push(line)
        line = ''
        used = 0
        if (ch === ' ') {
          continue
        }
      }
    }
    line += ch
    used += w
  }
  if (line !== '') {
    lines.push(line)
  }

  return lines
}

// Colour codes and other control characters, which tool output carries (a
// failing command's red error text) and the engine refuses in a tree: one
// such string made it draw none of the pane.
const CONTROL = /\x1b\[[0-9;?]*[ -\/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

export function clean(text: string): string {
  return text.replace(CONTROL, '')
}

/** Flatten to one line and cut it to `n` terminal cells, not `n` characters. */
function head(text: string, n: number): string {
  const flat = clean(text).replace(/<[^>]+>/g, ' ').split(/\s+/).join(' ').trim()
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
  /** The stored summary's key: what the turn says, and which of its kind it is. */
  key: string
  /** The ask's first words, normalised: what its message row is known by. */
  said: string
  /** The ask on one line, cut long: a title before the summary lands. */
  flat: string
  /** Every tool call of the turn, and the opening of each reply block. */
  toolIds: string[]
  replyKeys: string[]
  /** This turn alone, trimmed — what `complete` is given when only one is missing. */
  body: string
}

/** One row per message you sent, holding what the turns after it actually did. */
export function rowsOf(messages: readonly SessionMessage[]): Row[] {
  const rows: Row[] = []
  const seen = new Map<string, number>()
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
      // A summary is stored under what the turn says, not where it sits. The
      // list a session hands over can lose its head — after a compaction and
      // a resume it starts at the summary — and a key made of the position
      // then put turn 39's summary on whatever was 39th now.
      // ponytail: identical asks are told apart by their order alone, so a
      // shifted list can swap the reply lines of two "continue"s; key on the
      // message's own id if the API ever exposes one.
      const said = keyOf(m.text)
      const nth = (seen.get(said) ?? 0) + 1
      seen.set(said, nth)
      rows.push({
        n: rows.length + 1,
        key: `${said}#${nth}`,
        said,
        flat: excerpt(m.text.slice(0, 2000), 600, 0),
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
  const tail = tailOf(messages)
  if (cache === null || cache.tail !== tail) {
    // Every turn, including the ones that only talked: a trajectory with gaps
    // in its numbering is not a trajectory, and a turn that decided something
    // without touching a file is often the one that mattered.
    cache = { tail, rows: rowsOf(messages) }
    turnOfTool = new Map()
    turnOfText = new Map()
    sharedKeys = new Map()
    keyByN = cache.rows.map(r => r.key)
    latestN = cache.rows.length
    // A text two turns share ("continue", "Done.") cannot say which turn is on
    // screen, nor where a click should land; it is left out of both, and the
    // tool calls reported in the same burst decide instead.
    const claim = (k: string, n: number) => {
      const had = turnOfText.get(k)
      const shared = sharedKeys.get(k)
      if (shared !== undefined) {
        if (!shared.includes(n)) {
          shared.push(n)
        }
      } else if (had !== undefined && had !== n) {
        sharedKeys.set(k, [had, n])
      }
      turnOfText.set(k, n)
    }
    for (const row of cache.rows) {
      claim(row.said, row.n)
      for (const id of row.toolIds) {
        turnOfTool.set(id, row.n)
      }
      for (const k of row.replyKeys) {
        claim(k, row.n)
      }
    }
    for (const k of sharedKeys.keys()) {
      turnOfText.delete(k)
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

export const VERBS = ['help', 'find', 'fill', 'cost', 'lang', 'replies', 'close'] as const

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
    const match = /^\s*(\d+)\s*\|\s*(.+?)[\s|]*$/.exec(line)
    if (match !== null) {
      out[Number(match[1])] = match[2]!
    }
  }

  return out
}

export function parseFill(text: string): Record<number, { ask: string; did: string }> {
  const out: Record<number, { ask: string; did: string }> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)[\s|]*$/.exec(line)
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
      const lines = [`${r.isInjected ? '⏱' : '❯'} ${String(r.n).padStart(3)}  ${head(summary?.ask ?? r.flat, 68)}`]
      if (!doReplies) {
        return lines.join('\n')
      }
      const did = summary?.did || (summary !== undefined ? pendingOf(r, isRunning && r.n === rows.length, false) : null)
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
  size: string,
  doReplies: boolean,
  /** A fill you asked for retries whatever an automatic one gave up on. */
  isForced = false,
): Promise<string> {
  if (isForced) {
    tries.clear()
    callFailures = 0
  } else if (size === triedAt || callFailures >= CALL_FAILURES_MAX) {
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
  // A turn still running has only the start of its reply; a line written from
  // that would be kept for good. It waits until the turn ends.
  const running = isRunning ? rows[rows.length - 1] : undefined
  const upgradable = () =>
    doReplies
      ? rows.filter(r => r !== running && !isSpent(r.key) && summaries[r.key]?.did === '' && r.body.trim() !== '')
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
    type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | undefined
    const askUsages: Usage[] = []
    const replyUsages: Usage[] = []

    // One call writing a hundred lines made a first open wait for the last
    // line before showing the first. The backlog goes out in chunks, a few at
    // a time and the newest first, and each chunk is drawn as it lands.
    // A call that came back with nothing is tried again on the next draw
    // rather than at the next turn; `missed` bounds how often.
    // A failure says nothing: the card already falls back to the raw prompt.
    // An empty reply can come from what the rows hold, so they are charged for
    // it. An API error or an abort is not theirs: it counts against the call,
    // and after a few in a row automatic fills wait for the next turn rather
    // than retry on every redraw.
    const fail = (chunk: Row[], reason: string) => {
      if (reason === 'empty-reply') {
        for (const row of chunk) {
          missed(row.key)
        }
      } else {
        callFailures += 1
      }
      isRetried = callFailures < CALL_FAILURES_MAX
    }
    // Rows do not depend on summaries, so a landing redraws without refetching
    // the transcript.
    const land = async () => {
      await saveSummaries($, storeKey)
      redrawPane($)
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
        fail(chunk, reply.reason)

        return
      }
      askUsages.push(reply.usage)
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
        fail(chunk, reply.reason)

        return
      }
      replyUsages.push(reply.usage)
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

    const sum = (usages: Usage[]): Side => ({
      calls: usages.length,
      input: usages.reduce((n, u) => n + (u === undefined ? 0 : u.cache_read_input_tokens + u.input_tokens), 0),
      out: usages.reduce((n, u) => n + (u?.output_tokens ?? 0), 0),
    })
    const add = (to: Side, by: Side): Side => ({ calls: to.calls + by.calls, input: to.input + by.input, out: to.out + by.out })
    const none: Side = { calls: 0, input: 0, out: 0 }
    const askSide = sum(askUsages)
    const replySide = sum(replyUsages)
    const used = askSide.input + replySide.input
    const out = askSide.out + replySide.out
    spent = {
      ...add(spent, add(askSide, replySide)),
      quota: spent.quota,
      asks: add(spent.asks ?? none, askSide),
      replies: add(spent.replies ?? none, replySide),
    }
    // The quota windows move in tenths of a percent, so the difference across
    // the call is what this summary actually took out of the subscription.
    const quota = Math.max(0, quotaOf(await $.session.usage()) - before)
    spent.quota += quota
    await put($, `${storeKey}:spent`, spent)
    redrawPane($)

    const seconds = ((await $.clock.now()) - startedAt) / 1000
    const asked = full.length + asksOnly.length
    const partial = asksOnly.length > 0 ? `, ${asksOnly.length} ask-only` : ''

    return `summarised ${written} of ${asked} in ${seconds.toFixed(1)}s${partial}`
      + ` · ${k(used)} in, ${k(out)} out`
      + ` · ${quota.toFixed(1)}% of the 5h window`
  } finally {
    filling = false
    if (isRetried) {
      triedAt = ''
    }
    // A fill starts only when the pane draws, and a draw that came while
    // this one ran was skipped: a prompt sent meanwhile waited for whatever
    // drew the pane next — with nothing else redrawing it, the end of its
    // turn. The end of a fill is a draw of its own, so the next one starts
    // at once; one with nothing left to write returns before calling out.
    redrawPane($)
  }
}

let sessionKey: string | null = null

/**
 * The figures the usage line shows, as percentages used. The engine pushes
 * them on `session.measure` (after each turn, and when a rate window moves a
 * point), so they are not asked for; only a pane drawn before the first push
 * since this module loaded reads them once.
 */
type Meter = { context?: number; fiveHour?: number; sevenDay?: number }
let meter: Meter = {}
let hasMeter = false

type Usage = { context: { percent?: number }; rateLimits: readonly { kind: string; percentUsed: number }[] }

export function meterOf(usage: Usage): Meter {
  const rate = (kind: string) => usage.rateLimits.find(r => r.kind === kind)?.percentUsed

  return { context: usage.context.percent, fiveHour: rate('five_hour'), sevenDay: rate('seven_day') }
}

async function readMeter($: EngineInterface): Promise<void> {
  if (hasMeter) {
    return
  }
  hasMeter = true
  meter = meterOf(await $.session.usage())
}

/** A run of the usage line: its text and the theme colour it is drawn in. */
type Part = { text: string; color: string; bold?: boolean }

/**
 * The usage line, left side and right side, each figure marked as used. One
 * turns to the theme's warning colour past 80% and to the error colour past 95%.
 */
export function meterParts(m: Meter): { left: Part[]; right: Part[] } {
  const label = (text: string): Part => ({ text, color: 'inactive' })
  const used = (n: number): Part[] => [
    { text: `${Math.round(n)}%`, color: n >= 95 ? 'error' : n >= 80 ? 'warning' : 'text', bold: true },
    label(' used'),
  ]
  const left: Part[] = m.context === undefined ? [] : [label('Context '), ...used(m.context)]
  const right: Part[] = []
  for (const [name, n] of [['5h', m.fiveHour], ['7d', m.sevenDay]] as const) {
    if (n !== undefined) {
      right.push(label(`${right.length > 0 ? ' · ' : ''}${name} `), ...used(n))
    }
  }

  return { left, right }
}

let loading: Promise<string> | null = null

/**
 * One load at a time: a draw and a command overlapping both loaded, and the
 * second replaced summaries a running fill had just written.
 */
function loadStore($: EngineInterface, language: string): Promise<string> {
  loading ??= loadOnce($, language).catch(error => {
    loading = null
    throw error
  })

  return loading
}

async function loadOnce($: EngineInterface, language: string): Promise<string> {
  // Asked once: the pane is drawn often and the session does not change.
  const id = await $.session.id()
  sessionKey ??= `timeline:${id}`
  const storeKey = sessionKey
  if (!loaded) {
    void touchIndex($, id).catch(() => undefined)
    spent = ((await $.store.get(`${storeKey}:spent`)) as Spent | undefined)
      ?? { calls: 0, input: 0, out: 0, quota: 0 }
    const stored = ((await $.store.get(storeKey)) as Record<string, unknown>) ?? {}
    // v0 stored one string per turn. Those lack the ask side, so drop them and
    // let a fill write both — a refill is one call, not one per turn.
    // Summaries are written in one language; changing it in /config reloads
    // the module, and the ones already stored no longer match, so they go.
    const storedLanguage = await $.store.get(`${storeKey}:language`)
    // Read through the aliases, so summaries written under an option's old
    // name are kept rather than paid for again.
    const was = typeof storedLanguage === 'string' ? resolveLanguage(storedLanguage) : storedLanguage
    summaries = was === language
      ? (Object.fromEntries(
          // `t12`: the keys of the position-keyed store, which cannot be
          // matched to a turn any more. Dropped; a fill rewrites them.
          Object.entries(stored).filter(([k, v]) => typeof v === 'object' && v !== null && !/^t\d+$/.test(k)),
        ) as Record<string, Summary>)
      : {}
    if (was !== language) {
      await put($, `${storeKey}:language`, language)
    }
    // A prompt's row is only known once it has been drawn, and a reload or a
    // resume forgets which were: a card whose turn ran no tool then had
    // nothing to jump to and was not a button at all.
    const ids = ((await $.store.get(`${storeKey}:ids`)) as Record<string, string> | undefined) ?? {}
    for (const [key, id] of Object.entries(ids)) {
      if (!askIds.has(key)) {
        askIds.set(key, id)
      }
    }
    loaded = true
  }

  return storeKey
}

/** Written from the turn hooks, never from a draw. */
function saveIds($: EngineInterface): void {
  if (sessionKey !== null && askIds.size > 0) {
    void put($, `${sessionKey}:ids`, Object.fromEntries(askIds))
  }
}

function saveSummaries($: EngineInterface, storeKey: string): Promise<void> {
  return put($, storeKey, summaries)
}

const INDEX = 'timeline:sessions'

/**
 * A store write that cannot fail loudly. The store holds 4 MiB across every
 * session; when a write is refused the oldest fifth of the sessions are
 * dropped and it is tried once more. Nothing is dropped before that, since a
 * resumed session would otherwise come back to raw prompts and pay to refill.
 */
async function put($: EngineInterface, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    try {
      await evictOldest($)
      await $.store.set(key, value)
    } catch {
      // ponytail: a store still full after eviction keeps this session's
      // summaries in memory only; they are rewritten by the next fill.
    }
  }
}

/** When each session last opened its pane, so the oldest go first. */
async function touchIndex($: EngineInterface, id: string): Promise<void> {
  const index = ((await $.store.get(INDEX)) as Record<string, number> | undefined) ?? {}
  index[id] = Date.now()
  await $.store.set(INDEX, index).catch(() => undefined)
}

export function oldestFifth(index: Record<string, number>, all: string[], keep: string): string[] {
  const ids = [...new Set(all.map(k => /^timeline:([^:]+)/.exec(k)?.[1]).filter((id): id is string => id !== undefined && id !== 'sessions' && id !== keep))]
  ids.sort((a, b) => (index[a] ?? 0) - (index[b] ?? 0))

  return ids.slice(0, Math.max(1, Math.ceil(ids.length / 5)))
}

async function evictOldest($: EngineInterface): Promise<void> {
  const all = await $.store.keys()
  const index = ((await $.store.get(INDEX)) as Record<string, number> | undefined) ?? {}
  const keep = sessionKey?.slice('timeline:'.length) ?? ''
  const gone = new Set(oldestFifth(index, all, keep))
  for (const key of all) {
    const id = /^timeline:([^:]+)/.exec(key)?.[1]
    if (id !== undefined && gone.has(id)) {
      await $.store.delete(key)
    }
  }
  for (const id of gone) {
    delete index[id]
  }
  await $.store.set(INDEX, index)
}

export const register: Register = (on, options) => {
  const language = resolveLanguage(String(options.language ?? 'English')) ?? 'English'
  // Off: the reply pass is never built and never called. The ask pass still
  // runs, so a row still reads as a line rather than a raw prompt.
  const doReplies = options.replySummaries !== false

  // A pane is drawn when the engine asks, and new messages are not an ask.
  // Without this the pane sits on whatever the last draw found.
  // A prompt lands at turn.start, and the pane was only redrawn at
  // turn.complete — so a new row sat showing its raw text for the whole turn.
  on('session.measure', ($, e, next) => {
    meter = meterOf(e)
    hasMeter = true
    if (isOpen) {
      redrawPane($)
    }

    return next(e)
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    isOpen = false

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    cache = null
    isRunning = true
    callFailures = 0
    saveIds($)
    redrawPane($)

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    cache = null
    isRunning = false
    saveIds($)
    redrawPane($)

    return next(e)
  })

  // One stop per card. The ring's own order is every Button in the tree, so
  // an arrow off a title lands on the line under it or on the last line of
  // the card above; both are turned into the title of the card that was
  // meant. Above the first card drawn there are cards that are not in the
  // tree at all while the box scrolls them, and an arrow up went to the
  // search box instead; they are drawn first and then given the ring.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const land = async (key: string | undefined) => {
      const result = await next(key === undefined ? e : { ...e, element: key })
      if (result.deny === undefined) {
        focusedKey = key ?? null
        selected = cardOf(focusedKey)
      }

      return result
    }
    if (e.origin.kind !== 'person') {
      return land(e.element)
    }
    const goto = (n: number) => {
      const at = shownOrder.indexOf(n)
      const key = `j${n}`
      if (isFinding && at !== -1) {
        const was = findTop
        const to = at < was ? at : fitTop(heights, was, at, paneRows - HEAD_ROWS)
        if (to !== was) {
          findTop = to
          redrawPane($)
          if (at < was || at >= was + drawnCount) {
            // Not in the tree yet: `$.ui.focus` waits for the drawing that brings it.
            void $.ui.focus({ requestId: PANE, key }).catch(() => undefined)

            return {}
          }
        }
      }

      return land(key)
    }
    const from = cardOf(focusedKey)
    const to = cardOf(e.element)
    if (to !== null) {
      // The line under the title of the card the ring is on: an arrow down.
      if (from === to && e.element !== `j${to}`) {
        const below = shownOrder[shownOrder.indexOf(to) + 1]

        return below === undefined ? {} : goto(below)
      }

      return goto(to)
    }
    if (isFinding && from !== null && (e.element === 'find' || e.element === 'find-back')) {
      const at = shownOrder.indexOf(from)
      const above = shownOrder[at - 1]
      if (at === findTop && above !== undefined) {
        return goto(above)
      }
    }

    return land(e.element)
  })

  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    if (!isFinding || isResetting) {
      return next(e)
    }
    // Not the person's: a move made to show the ring. The cards are placed
    // for it already, and the window stays where it is.
    if (e.origin.kind !== 'person') {
      return {}
    }
    const cards = Math.sign(e.by) * Math.max(1, Math.round(Math.abs(e.by) / 4))
    // The wheel says where it was; the scroll keys do not. An arrow in a pane
    // is a scroll key, so here it is what moves the ring from card to card,
    // and Enter then jumps to the card it is on.
    if (e.pointer === undefined) {
      const at = selected === null ? -1 : shownOrder.indexOf(selected)
      if (at === 0 && cards < 0) {
        selected = null
        void $.ui.focus({ requestId: PANE, key: 'find' }).catch(() => undefined)

        return {}
      }
      const to = at === -1 ? findTop : Math.min(shownOrder.length - 1, Math.max(0, at + cards))
      const n = shownOrder[to]
      if (n !== undefined) {
        selected = n
        const top = to < findTop ? to : fitTop(heights, findTop, to, paneRows - HEAD_ROWS)
        const ring = () => {
          // The latest press wins: an earlier one's ring is not worth landing.
          if (selected === n) {
            void $.ui.focus({ requestId: PANE, key: `j${n}` }).catch(() => undefined)
          }
        }
        if (top !== findTop) {
          findTop = top
          redrawPane($)
          // After the redraw: given the ring where it sits now, below the
          // window, the engine would move the window to show it and take the
          // search box off the top.
          $.clock.after(60, ring)
        } else {
          ring()
        }
      }

      return {}
    }
    const to = Math.min(lastTop(heights, paneRows - HEAD_ROWS), Math.max(0, findTop + cards))
    if (to !== findTop) {
      findTop = to
      redrawPane($)
      keepRing($)
    }

    return {}
  })

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const key = keyOf(e.props.text)
    if (key === '') {
      return next(e)
    }
    if (cache !== null && !turnOfText.has(key) && !sharedKeys.has(key)) {
      isStale = true
    }
    askIds.set(key, e.requestId)

    track($, e.requestId, e.props.onScreen, { text: key, isAsk: true })

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
      description: 'Open or close the timeline pane — also `find`, `fill`, `cost`, `lang`, `replies on|off`',
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
          '  /timeline                 open the pane, or close it if it is open',
          '  /timeline find [words]    search the turns by meaning; bare, hides or shows the search box',
          '  /timeline fill            summarise everything missing now',
          '  /timeline cost            what the summaries took: prompts, replies, share of the 5h window',
          '  /timeline lang <name>     ' + LANGUAGES.join(' | '),
          '  /timeline replies on|off  write the reply side, or only the ask',
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
          : 'timeline: replies off. Cards show only what you asked and nothing is spent on replies; what was written is kept for `replies on`.',
      }
    }

    // Bare, the command is a switch, as Claude Code's own panes are. `close`
    // is kept for anyone who learned it.
    if (verb === 'close' || (word === '' && (await $.ui.panes()).some(pane => pane.id === PANE))) {
      await $.ui.close({ id: PANE })

      return { text: 'timeline: closed' }
    }

    const messages = await $.session.messages()
    if ('deny' in messages) {
      return { text: `timeline: cannot read this session (${messages.deny})` }
    }
    const rows = rowsCached(messages)
    const storeKey = await loadStore($, language)

    if (verb === 'cost') {
      await loadStore($, language)

      return { text: costText(spent, doReplies) }
    }

    if (verb === 'find') {
      // Bare, it is a switch: the box closes, and the same words open it.
      if (rest === '' && isFinding) {
        closeFind($)

        return { text: 'timeline: search box hidden — `/timeline find` brings it back' }
      }
      // `focus` hands the keyboard to the pane, where the field asks for it.
      const opened = await $.ui.open({ id: PANE, title: 'Timeline', focus: true })
      if (!opened.isPlaced) {
        return { text: `timeline: this surface draws no pane (${opened.reason})` }
      }
      // The window goes to the head before the box takes over its scrolling.
      await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
      isFinding = true
      findTop = 0
      if (rest !== '') {
        void runFind($, rows, rest)

        return { text: `timeline: searching for "${rest}"` }
      }
      redrawPane($)

      return { text: 'timeline: search box shown — type in it and press Enter. `/timeline find` again hides it.' }
    }

    if (verb === 'fill') {
      if (filling) {
        return { text: 'timeline: a fill is already running.' }
      }
      const line = await runFill($, rows, storeKey, language, tailOf(messages), doReplies, true)

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
      const line = await runFill($, rows, storeKey, language, tailOf(messages), doReplies)

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
    await readMeter($)
    // The transcript is fetched only when a turn has changed it. A
    // redraw because the marker moved reuses the rows it already has, so
    // scrolling does not pull the whole session across on every step.
    let rows: Row[]
    let size: string
    if (cache === null) {
      const messages = await $.session.messages()
      if ('deny' in messages) {
        return <Text color="text" dimColor>cannot read this session</Text>
      }
      rows = rowsCached(messages)
      size = tailOf(messages)
    } else {
      rows = cache.rows
      size = cache.tail
    }
    // Read so that bumping it redraws this pane alone.
    await read($, drawAtom)
    isOpen = true
    // The maps may just have caught up with rows that reported before them.
    recompute()
    loop($)
    const nowAt = markedN
    drawnMark = nowAt
    // The pane's own body, not `e.viewport`: that is the conversation's width,
    // and sizing by it cut every line for a column twice as wide as the pane.
    // Less the pane's right pad, the card's border and its padding.
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 5)
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
      void runFill($, rows, storeKey, language, size, doReplies).catch(() => undefined)
    }

    // For each row, the last tool call of the rows before it: one pass.
    let lastTool: string | undefined
    const above = rows.map(r => {
      const before = lastTool
      lastTool = r.toolIds.at(-1) ?? lastTool

      return before
    })

    // Not every surface has a text field; where there is none the box is not
    // drawn and `/timeline find <words>` still searches.
    const table = $.ui.resolve(e)
    const Input = 'Input' in table ? table.Input : undefined
    const shown = isFinding && matches !== null
      ? matches.map(n => rows[n - 1]).filter((r): r is Row => r !== undefined)
      : rows
    shownOrder = shown.map(r => r.n)
    isPaneFocused = e.props.isFocused === true
    // The window is meant to stay at the head while the box is up. If the
    // engine moved it all the same (to show the ring), it is put back.
    if (isFinding && (e.props.scroll?.offset ?? 0) !== 0 && !isResetting) {
      isResetting = true
      $.clock.after(0, () => {
        void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined).then(() => {
          isResetting = false
        })
      })
    }
    paneRows = e.props.scroll?.bodyRows ?? paneRows
    // A card's rows: its border, the gap above it, its title and what is
    // drawn under that. The same lines the card draws below.
    heights = !isFinding ? [] : shown.map(row => {
      const summary = summaries[row.key]
      const did = !doReplies
        ? null
        : summary?.did || (summary !== undefined ? pendingOf(row, isRunning && row.n === rows.length, filling) : null)
      const errors = doReplies ? Math.min(2, row.errors.length) + (row.errors.length > 2 ? 1 : 0) : 0

      return 4
        + (did === null ? 0 : wrapCells(`  → ${did}`, width).length)
        + (doReplies && row.facts.length > 0 ? wrapCells(`  ${row.facts.join(' · ')}`, width).length : 0)
        + errors
    })
    if (isFinding) {
      // A window that grew, or cards that got shorter, can leave the first
      // card past where the last one would sit at the bottom.
      findTop = Math.min(findTop, lastTop(heights, paneRows - HEAD_ROWS))
      drawnCount = fitCount(heights, findTop, paneRows - HEAD_ROWS)
    }
    const status = isSearching
      ? 'searching…'
      : matches === null
        ? 'Enter searches by meaning'
        : matches.length === 0
          ? `nothing matches "${head(query, 24)}"`
          : `${matches.length} match${matches.length > 1 ? 'es' : ''}, best first — click one to jump to it`

    const { left, right } = meterParts(meter)
    const run = (parts: Part[], at: string) => parts.map((part, i) => (
      <Text key={`${at}${i}`} color={part.color} bold={part.bold}>{part.text}</Text>
    ))

    return (
      <Box flexDirection="column" paddingRight={1}>
        {/* How much of the context window and of the rate windows is used:
            figures only, coloured as they near the edge. */}
        {(left.length > 0 || right.length > 0) && (
          <Box flexDirection="row" justifyContent="space-between" paddingX={2}>
            <Box flexDirection="row">{run(left, 'ml')}</Box>
            <Box flexDirection="row">{run(right, 'mr')}</Box>
          </Box>
        )}
        {rows.length === 0 && <Text color="text" dimColor>Nothing yet.</Text>}
        {isFinding && Input !== undefined && (
          <Box flexDirection="column">
            <Box borderStyle="round" borderColor="claude" paddingX={1}>
              <Input
                key="find"
                label="Find"
                placeholder="describe the turn you are looking for"
                value={query}
                submitLabel="search"
                autoFocus
                onSubmit={(value: string) => {
                  void runFind($, rows, value)
                }}
              />
            </Box>
            {/* The command that closes it is the one thing here to act on, so
                it is the one thing in the accent. */}
            <Box paddingX={2}>
              <Text color="inactive">{status}</Text>
            </Box>
            {/* The way out of the results that needs no typing: back to every
                card, the box left open. A primary Button is drawn in the
                accent, `[ so ]`. The box itself shuts with the command. */}
            <Box flexDirection="row" paddingX={2} gap={1}>
              {matches !== null && (
                <Button
                  key="find-back"
                  variant="primary"
                  label="back to timeline"
                  onPress={() => {
                    void runFind($, rows, '')
                  }}
                />
              )}
              {matches !== null && <Text color="inactive">·</Text>}
              <Text color="claude" bold>/timeline find</Text>
              <Text color="inactive">hides the search box</Text>
            </Box>
          </Box>
        )}
        {(isFinding ? shown.slice(findTop, findTop + drawnCount) : shown).map(row => {
          // Its own prompt, else its first tool call, else the last tool call
          // before it — the nearest row above that the transcript can find.
          // A duplicate ask's own row once the reports have placed it, else its
          // first tool call, else a row with its text (which of them is a guess).
          const id = (sharedKeys.has(row.said) ? askIdByKey.get(row.key) : askIds.get(row.said))
            ?? row.anchor
            ?? askIds.get(row.said)
            ?? above[row.n - 1]
          const summary = summaries[row.key]
          const mark = `${row.isInjected ? '⏱' : '❯'} ${row.n}  `
          const title = summary?.ask ?? row.flat
          // Replies off is also "show me only what I asked": the reply line,
          // the tally and the errors all go, though what is stored is kept.
          const did = !doReplies
            ? null
            : summary?.did || (summary !== undefined ? pendingOf(row, isRunning && row.n === rows.length, filling) : null)
          const jump = () => {
            if (id !== undefined) {
              void $.ui.scroll({ to: { requestId: id }, block: 'start' })
            }
            // A click lands the ring on the line clicked; it belongs on the title.
            void $.ui.focus({ requestId: PANE, key: `j${row.n}` }).catch(() => undefined)
          }
          // One line of the card. Only a Button takes a press, and its hit area
          // is its label, so each line is a Button padded to the card's width:
          // a click anywhere on the card lands on one. A Button's label takes
          // no colour at rest except through `dimColor`, which the engine
          // draws in the theme's `inactive` — the terminal's own foreground
          // vanished wherever the theme and the terminal disagreed. Under the
          // pointer the whole card comes up to the theme's text colour.
          const line = (key: string, text: string, room = width) => (
            <Button
              plain
              dimColor
              key={key}
              label={pad(text, room)}
              hover={{ color: 'text', dimColor: false, inverse: false }}
              onPress={jump}
            />
          )

          return (
            <Box
              key={`t${row.n}`}
              flexDirection="column"
              marginTop={1}
              paddingX={1}
              borderStyle="round"
              borderColor={row.n === nowAt ? 'claude' : 'promptBorder'}
              borderDimColor={row.n !== nowAt}
              // The pane sits on a grey of the theme's; the one card you are at
              // takes the theme's inverse-text colour — white on a light theme,
              // black on a dark one — so it reads as lifted off the pane. A
              // theme key, not a colour picked by theme name: under `auto` only
              // the engine knows which way the theme resolved.
              backgroundColor={row.n === nowAt ? 'inverseText' : undefined}
            >
              <Box flexDirection="row">
                <Box flexShrink={0}>
                  <Text color={row.isInjected ? 'inactive' : 'claude'} bold>{mark}</Text>
                </Box>
                {line(`j${row.n}`, head(title, width - cells(mark)), width - cells(mark))}
              </Box>
              {did !== null && wrapCells(`  → ${did}`, width).map((text, i) => line(`d${row.n}.${i}`, text))}
              {doReplies && row.facts.length > 0
                && wrapCells(`  ${row.facts.join(' · ')}`, width).map((text, i) => line(`f${row.n}.${i}`, text))}
              {(doReplies ? row.errors : []).slice(0, 2).map((err, i) => (
                <Text key={`t${row.n}e${i}`} color="error" wrap="wrap">
                  {'  ⚠ '}
                  {head(err, width - 4)}
                </Text>
              ))}
              {doReplies && row.errors.length > 2 && (
                <Text color="error">{'  ⚠ '}…and {row.errors.length - 2} more</Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}

import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const PANE = 'timeline'
const LANGUAGES = ['English', '中文', '日本語', 'Español', 'Français', 'Deutsch'] as const

// A message row's own render id, seen only while that row is drawn. Preferred
// as a jump target because it lands on the ask; `anchor` (the turn's first tool
// row, always in the transcript) is the fallback that also covers history.
const askIds = new Map<string, string>()

// Rows are derived from the whole transcript, which a pane redraws often. The
// walk is linear in the session, so cache it and only redo it when the
// transcript has grown.
let cache: { size: number; rows: Row[] } | null = null

// Summaries, by anchor. Written once, read from the store on every load — a
// fork is the expensive part of this mod and nothing is ever recomputed.
type Summary = { ask: string; did: string }
let summaries: Record<string, Summary> = {}
let loaded = false

// Auto-fill runs only while the pane is open, so nothing is spent on summaries
// nobody is looking at. Turns arrive one per prompt, already spaced, so each is
// filled as it lands — there is no burst to debounce.
let filling = false
/** Keys a fill tried and could not write. Without this a row the model keeps
    declining to summarise is retried on every draw, forever, each one paid for. */
const failed = new Set<string>()
/**
 * The transcript size at the last attempt. A draw happens for many reasons and
 * most change nothing, so a fill that failed must not be retried until there is
 * something new to try it on — a resumed session has no forkable thread until
 * its first turn ends, and without this it asks again on every redraw.
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
      })
    } else if (m.role === 'assistant') {
      uses = [...uses, ...m.toolUses]
      const row = rows[rows.length - 1]
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
  }

  return cache.rows
}

/**
 * The fork sees the whole conversation, so it is asked for every missing turn
 * at once: one call amortizes the cached-prefix read over all of them, where
 * one call per turn would pay that read again each time.
 */
function fillPrompt(rows: Row[], language: string): string {
  const asked = rows.map(r => `${r.n}. ${head(r.ask, 110)}`).join('\n')

  return [
    'For each turn below, write two things: what I asked, and what YOU did about it.',
    '',
    'Output one line per turn, nothing else. No preamble, no closing line, no markdown:',
    '<number>|<my ask in up to 10 words>|<what you did in up to 16 words, past tense>',
    '',
    'The ask side is the point of the turn, not its wording — say what I wanted,',
    'not how I phrased it. The did side names the concrete thing: the file, the',
    'fix, the finding, the number. A turn that only talked still did something:',
    'say what was decided or explained.',
    '',
    'If a turn failed, stalled or was abandoned, say so plainly — never smooth a',
    'failure into an accomplishment.',
    '',
    `Write both fields in ${language}, whatever language the turn itself is in.`,
    '',
    'Turns:',
    asked,
  ].join('\n')
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
    `ASKED: ${head(row.ask, 400)}`,
    `DID:\n${row.body.slice(0, 5000)}`,
  ].join('\n')
}

/**
 * The asks alone, for turns whose reply is not available: still in flight, or
 * in a resumed session with no forkable thread. A prompt is always there, so a
 * row can always say what it was for even when it cannot say what came of it.
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
    ...rows.map(r => `${r.n}. ${head(r.ask, 110)}`),
  ].join('\n')
}

/**
 * Several turns with their replies, for `complete`, which sees only what it is
 * given. Used where a fork cannot run; each body is trimmed hard so a whole
 * backlog still fits one call.
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
    ...rows.map(r => `--- ${r.n}\nASKED: ${head(r.ask, 200)}\nDID: ${r.body.slice(0, each)}`),
  ].join('\n')
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

/** The same rows as text, for a surface that draws no pane. */
function asText(rows: Row[], store: Record<string, Summary>): string {
  return rows
    .map(r => {
      const summary = store[r.key]
      const lines = [`${r.isInjected ? '⏱' : '❯'} ${String(r.n).padStart(3)}  ${head(summary?.ask ?? r.ask, 68)}`]
      if (summary !== undefined) {
        lines.push(`      → ${summary.did === '' ? 'waiting…' : summary.did}`)
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
 * Summarise every turn that has none, in one fork, and store the result.
 * Resolves a line saying what it cost, or '' when there was nothing to do.
 */
async function runFill(
  $: EngineInterface,
  rows: Row[],
  storeKey: string,
  language: string,
  size: number,
  /** A fill you asked for retries whatever an automatic one gave up on. */
  isForced = false,
): Promise<string> {
  if (isForced) {
    failed.clear()
  } else if (size === triedAt) {
    return ''
  }
  // A prompt is there at once and a reply is not, so the ask is always written
  // first and the reply side upgrades it later. Waiting for the reply to write
  // either is what left a new row showing its raw prompt for a whole turn.
  const asksOnly = rows.filter(r => !failed.has(r.key) && summaries[r.key] === undefined)
  const full = rows.filter(
    r => !failed.has(r.key) && summaries[r.key]?.did === '' && r.body.trim() !== '',
  )
  if ((full.length === 0 && asksOnly.length === 0) || filling) {
    return ''
  }
  filling = true
  triedAt = size
  const startedAt = await $.clock.now()
  const before = quotaOf(await $.session.usage())
  try {
    let written = 0
    let fellBack: Row[] = []
    const usages: ({ input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | undefined)[] = []

    // The asks go first and the pane is redrawn the moment they land: they are
    // short, they need no reply, and they are what turns a raw prompt into a
    // line you can read while the turn is still running.
    if (asksOnly.length > 0) {
      const reply = await $.model.complete({
        model: 'haiku',
        effort: 'low',
        maxTokens: Math.min(4000, 40 + asksOnly.length * 30),
        prompt: asksPrompt(asksOnly, language),
      })
      if (reply.isAnswered) {
        usages.push(reply.usage)
        const parsed = parseAsks(reply.text)
        for (const row of asksOnly) {
          const got = parsed[row.n]
          if (got !== undefined) {
            summaries[row.key] = { ask: got, did: '' }
            written += 1
          }
        }
        await $.store.set(storeKey, summaries)
        cache = null
        $.ui.invalidate('ui.render')
      }
    }

    // One missing turn is given to `complete`, which carries no history: it
    // reads that turn alone. A fork would re-read the whole transcript to
    // write one line, and the prefix read is what a fork costs — about forty
    // times this on a long session. Several go the other way: one fork
    // amortizes that read across all of them.
    const only = full.length === 1 ? full[0] : undefined
    if (full.length > 0) {
      const reply = only === undefined
        ? await $.model.fork({ prompt: fillPrompt(full, language) })
        : await $.model.complete({
            model: 'haiku',
            effort: 'low',
            maxTokens: 200,
            prompt: onePrompt(only, language),
          })
      if (reply.isAnswered) {
        usages.push(reply.usage)
        const parsed = parseFill(reply.text)
        for (const row of full) {
          const got = parsed[row.n]
          if (got === undefined) {
            failed.add(row.key)
          } else {
            summaries[row.key] = got
            written += 1
          }
        }
      } else if (reply.reason === 'nothing-to-fork') {
        // A resumed session has no thread to fork until its own first turn
        // ends — but the replies are in the transcript either way, so ask the
        // same question a way that needs no history rather than settle for
        // less. Only a turn with nothing written yet falls back to ask-only.
        const second = await $.model.complete({
          model: 'haiku',
          effort: 'low',
          maxTokens: Math.min(8000, 100 + full.length * 45),
          prompt: batchPrompt(full, language),
        })
        if (second.isAnswered) {
          usages.push(second.usage)
          const parsed = parseFill(second.text)
          for (const row of full) {
            const got = parsed[row.n]
            if (got === undefined) {
              failed.add(row.key)
            } else {
              summaries[row.key] = got
              written += 1
            }
          }
        } else {
          fellBack = full
        }
      } else {
        for (const row of full) {
          failed.add(row.key)
        }
      }
    }

    const asks = fellBack
    if (asks.length > 0) {
      const reply = await $.model.complete({
        model: 'haiku',
        effort: 'low',
        maxTokens: Math.min(4000, 40 + asks.length * 30),
        prompt: asksPrompt(asks, language),
      })
      if (reply.isAnswered) {
        usages.push(reply.usage)
        const parsed = parseAsks(reply.text)
        for (const row of asks) {
          const got = parsed[row.n]
          if (got !== undefined) {
            // `did` stays empty: the row is written but still open, and a
            // later fill upgrades it once the reply exists.
            summaries[row.key] = { ask: got, did: '' }
            written += 1
          }
        }
      }
    }

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
    // The header scrolls away on a long timeline, so the cost rides the pane's
    // own title, which does not.
    void $.ui.open({ id: PANE, title: `Timeline · ${spentLine()}` })
    $.ui.invalidate('ui.render')

    const seconds = ((await $.clock.now()) - startedAt) / 1000
    const asked = full.length + asksOnly.length
    const partial = asksOnly.length > 0 ? `, ${asksOnly.length} ask-only` : ''

    return `summarised ${written} of ${asked} in ${seconds.toFixed(1)}s${partial}`
      + ` · ${k(used)} in, ${k(out)} out`
      + ` · ${quota.toFixed(1)}% of the 5h window`
  } finally {
    filling = false
  }
}

async function loadStore($: EngineInterface, language: string): Promise<string> {
  const storeKey = `timeline:${await $.session.id()}`
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

  // A pane is drawn when the engine asks, and new messages are not an ask.
  // Without this the pane sits on whatever the last draw found.
  // A prompt lands at turn.start, and the pane was only redrawn at
  // turn.complete — so a new row sat showing its raw text for the whole turn.
  on('turn.start', ($, e, next) => {
    cache = null
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    cache = null
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const key = e.props.text.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (key !== '') {
      askIds.set(key, e.requestId)
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'timeline',
      description: 'What this session did — `fill`, `print`, `lang <language>`, `close`',
    })

    return next(e)
  })

  on('command.run', { command: 'timeline' }, async ($, e) => {
    const arg = (e.args ?? '').trim()

    // `/config` lists every mod's options in one place, which is where they
    // belong; a mod with its own command should also answer for its own
    // setting. Both write the same row, so there is one source of truth.
    if (arg === 'lang' || arg.startsWith('lang ')) {
      const want = arg.slice(4).trim()
      if (want === '') {
        return {
          text: `timeline: summaries are in ${language}.`
            + `\n  /timeline lang <${LANGUAGES.join(' | ')}>`,
        }
      }
      const picked = LANGUAGES.find(l => l.toLowerCase() === want.toLowerCase())
      if (picked === undefined) {
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

    if (arg === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'timeline: closed' }
    }

    const messages = await $.session.messages()
    if ('deny' in messages) {
      return { text: `timeline: cannot read this session (${messages.deny})` }
    }
    const rows = rowsCached(messages)
    const storeKey = await loadStore($, language)

    if (arg === 'fill') {
      const line = await runFill($, rows, storeKey, language, messages.length, true)

      return { text: `timeline: ${line === '' ? 'every turn already has a summary.' : line}` }
    }

    if (rows.length === 0) {
      return { text: 'timeline: nothing recorded yet.' }
    }

    if (arg !== 'print') {
      const title = spentLine()
      const opened = await $.ui.open({ id: PANE, title: title === '' ? 'Timeline' : `Timeline · ${title}` })
      if (opened.isPlaced) {
        // Opening it is the signal that someone wants to read it: catch up on
        // whatever accumulated while it was closed, in one fork.
        const line = await runFill($, rows, storeKey, language, messages.length)

        return { text: line === '' ? 'timeline: pane opened' : `timeline: ${line}` }
      }
      // No pane here: Remote Control and the VS Code extension attach no pane
      // surface (anthropics/claude-code#99217, #99045), and a narrow terminal
      // seats none. Say which, and print it rather than report a pane nobody
      // can see.
      return {
        text: `timeline: this surface draws no pane (${opened.reason})\n\n${asText(rows, summaries)}`,
      }
    }

    return { text: `timeline · ${rows.length} turns\n\n${asText(rows, summaries)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // A reload empties the module's own variables while the store keeps its
    // summaries, and a draw can be the first thing to run after one — so the
    // drawing loads them itself rather than trusting a command to have run.
    const storeKey = await loadStore($, language)
    const messages = await $.session.messages()
    if ('deny' in messages) {
      return <Text dimColor>cannot read this session</Text>
    }

    const rows = rowsCached(messages)
    const width = Math.max(24, (e.viewport?.columns ?? 40) - 6)
    const unsummarised = rows.filter(r => summaries[r.key] === undefined).length

    // Drawing the pane is the signal that someone is reading it, and the only
    // one that holds across a reload, a reopen and a new turn alike. The fill
    // is not awaited: the tree goes back now with the asks as written, and the
    // summaries land on the redraw its own invalidate causes. `filling` and
    // the missing count bound it — once nothing is missing, no fork runs.
    if (unsummarised > 0 && !filling) {
      void runFill($, rows, storeKey, language, messages.length).then(line => {
        if (line !== '') {
          $.ui.log(`timeline: ${line}`)
        }
      })
    }

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text dimColor>
          {rows.length} turns
          {unsummarised > 0 ? ` · ${unsummarised} to summarise` : ''}
          {spent.calls > 0 ? ` · summaries: ${spentLine()}` : ''}
        </Text>
        {rows.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {rows.map(row => {
          const id = askIds.get(row.ask.replace(/\s+/g, ' ').trim().slice(0, 60)) ?? row.anchor
          const summary = summaries[row.key]
          const mark = `${row.isInjected ? '⏱' : '❯'} ${row.n}`
          const title = summary?.ask ?? row.ask
          const headline = `${mark}  ${head(title, width - cells(mark) - 2)}`

          return (
            <Box
              key={`t${row.n}`}
              flexDirection="column"
              marginTop={1}
              paddingX={1}
              borderStyle="round"
              borderColor="promptBorder"
              borderDimColor
            >
              {/* The whole headline is the control: a row needs a jump, not a
                  word saying "jump". The focus ring and the pointer are the
                  affordance, so no icon has to be invented or borrowed. A
                  Button takes one plain string, so nothing nests inside it. */}
              {id === undefined ? (
                <Text wrap="truncate-end" dimColor={row.isInjected}>{headline}</Text>
              ) : (
                <Button
                  plain
                  key={`j${row.n}`}
                  label={headline}
                  dimColor={row.isInjected}
                  onPress={() => {
                    void $.ui.scroll({ to: { requestId: id }, block: 'start' })
                  }}
                />
              )}
              {summary !== undefined && (
                // An ask-only row is written the moment the prompt lands and
                // upgraded when the reply exists. A bare arrow reads as broken,
                // so a row still waiting says which wait it is in: a call is
                // running, or there is nothing to run it on yet.
                <Text wrap="wrap" dimColor={summary.did === '' || row.isInjected}>
                  {'  → '}
                  {summary.did === '' ? (filling ? 'summarising…' : 'waiting…') : summary.did}
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
      </Box>
    )
  })
}

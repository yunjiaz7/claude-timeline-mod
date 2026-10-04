import type { Register, SessionMessage } from 'claude-code'

const PANE = 'timeline'

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

const WRITES = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

// `cd x && python train.py` really ran `python train.py`, not `cd`.
// Found the hard way: without stripping the preamble every tally read `cd×N`.
const NOISE = new Set(['cd', 'export', 'source', 'set', 'unset', 'echo'])
const PREFIX = new Set(['timeout', 'nohup', 'sudo', 'env', 'time', 'nice', 'xargs', 'command'])
const KEEP_ARG = new Set(['python', 'python3', 'uv', 'npm', 'npx', 'git', 'gh', 'bash', 'sh', 'cargo', 'go'])

export function verbOf(cmd: string): string | null {
  // Only the first line, and nothing past a heredoc marker: a `python3 - <<EOF`
  // body is data, and tallying words out of it is noise, not signal.
  const line = cmd.split('\n')[0].split('<<')[0]
  for (const part of line.split(/&&|\|\||;/)) {
    const words = part.trim().split(/\s+/).filter(Boolean)
    while (words.length > 0 && (PREFIX.has(words[0]) || words[0].includes('=') || /^\d+$/.test(words[0]))) {
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
      })
    } else if (m.role === 'assistant') {
      uses = [...uses, ...m.toolUses]
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
function fillPrompt(rows: Row[]): string {
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
    'Turns:',
    asked,
  ].join('\n')
}

export function parseFill(text: string): Record<number, { ask: string; did: string }> {
  const out: Record<number, { ask: string; did: string }> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$/.exec(line)
    if (match !== null) {
      out[Number(match[1])] = { ask: match[2], did: match[3] }
    }
  }

  return out
}

export const register: Register = on => {
  // A pane is drawn when the engine asks, and new messages are not an ask.
  // Without this the pane sits on whatever the last draw found.
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
      description: 'What this session actually did — `fill` to summarise, `print` for text',
    })

    return next(e)
  })

  on('command.run', { command: 'timeline' }, async ($, e) => {
    const arg = (e.args ?? '').trim()

    if (arg === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'timeline: closed' }
    }

    const messages = await $.session.messages()
    if ('deny' in messages) {
      return { text: `timeline: cannot read this session (${messages.deny})` }
    }
    const rows = rowsCached(messages)
    const storeKey = `timeline:${await $.session.id()}`

    if (!loaded) {
      const stored = ((await $.store.get(storeKey)) as Record<string, unknown>) ?? {}
      // v0 stored one string per turn. Those lack the ask side, so drop them
      // and let `fill` write both — a refill is one call, not one per turn.
      summaries = Object.fromEntries(
        Object.entries(stored).filter(([, v]) => typeof v === 'object' && v !== null),
      ) as Record<string, Summary>
      loaded = true
    }

    if (arg === 'fill') {
      const missing = rows.filter(r => summaries[r.key] === undefined)
      if (missing.length === 0) {
        return { text: 'timeline: every turn already has a summary.' }
      }

      const reply = await $.model.fork({ prompt: fillPrompt(missing) })
      if (!reply.isAnswered) {
        return { text: `timeline: could not summarise (${reply.reason})` }
      }

      const parsed = parseFill(reply.text)
      let written = 0
      for (const row of missing) {
        const got = parsed[row.n]
        if (got !== undefined) {
          summaries[row.key] = got
          written += 1
        }
      }
      await $.store.set(storeKey, summaries)
      cache = null
      $.ui.invalidate('ui.render')

      // What it actually cost, measured. `cache_read` near zero means the
      // prefix had lapsed and this fork paid full price for the transcript.
      const u = reply.usage
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
      const cost = u === undefined
        ? ''
        : `\n  ${k(u.cache_read_input_tokens)} cached + ${k(u.input_tokens)} fresh in, ${k(u.output_tokens)} out`
          + `${u.cache_read_input_tokens < u.input_tokens ? '  ← prefix had lapsed, this one paid full price' : ''}`

      return { text: `timeline: summarised ${written} of ${missing.length} turns in one fork.${cost}` }
    }

    if (rows.length === 0) {
      return { text: 'timeline: nothing recorded yet.' }
    }

    if (arg !== 'print') {
      const opened = await $.ui.open({ id: PANE, title: 'Timeline' })
      if (opened.isPlaced) {
        return { text: 'timeline: pane opened' }
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
    const messages = await $.session.messages()
    if ('deny' in messages) {
      return <Text dimColor>cannot read this session</Text>
    }

    const rows = rowsCached(messages)
    const width = Math.max(24, (e.viewport?.columns ?? 40) - 6)
    const unsummarised = rows.filter(r => summaries[r.key] === undefined).length

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text dimColor>
          {rows.length} turns
          {unsummarised > 0 ? ` · ${unsummarised} unsummarised (/timeline fill)` : ''}
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
                <Text wrap="wrap" dimColor={row.isInjected}>
                  {'  → '}
                  {summary.did}
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

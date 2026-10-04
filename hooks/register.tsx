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
let summaries: Record<string, string> = {}
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

function head(text: string, n: number): string {
  const flat = text.replace(/<[^>]+>/g, ' ').split(/\s+/).join(' ').trim()

  return flat.length > n ? `${flat.slice(0, n)}…` : flat
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
    cache = {
      size: messages.length,
      rows: rowsOf(messages).filter(r => r.facts.length > 0 || r.errors.length > 0),
    }
  }

  return cache.rows
}

/**
 * The fork sees the whole conversation, so it is asked for every missing turn
 * at once: one call amortizes the cached-prefix read over all of them, where
 * one call per turn would pay that read again each time.
 */
function fillPrompt(rows: Row[]): string {
  const asked = rows.map(r => `${r.n}. ${head(r.ask, 90)}`).join('\n')

  return [
    'Summarise what YOU did in each of the turns below — not what was discussed,',
    'and not what I asked, which I can already read.',
    '',
    'Output one line per turn, nothing else. No preamble, no closing line, no markdown:',
    '<number>|<up to 16 words, past tense, naming the concrete thing>',
    '',
    'Name the file, the fix, the finding, the number. If the turn failed or was',
    'abandoned, say so plainly — never smooth a failure into an accomplishment.',
    '',
    'Turns:',
    asked,
  ].join('\n')
}

export function parseFill(text: string): Record<number, string> {
  const out: Record<number, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s*\|\s*(.+?)\s*$/.exec(line)
    if (match !== null) {
      out[Number(match[1])] = match[2]
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
      summaries = ((await $.store.get(storeKey)) as Record<string, string>) ?? {}
      loaded = true
    }

    if (arg === 'fill') {
      const missing = rows.filter(r => r.anchor !== undefined && summaries[r.anchor] === undefined)
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
        const line = parsed[row.n]
        if (line !== undefined && row.anchor !== undefined) {
          summaries[row.anchor] = line
          written += 1
        }
      }
      await $.store.set(storeKey, summaries)
      cache = null
      $.ui.invalidate('ui.render')

      return { text: `timeline: summarised ${written} of ${missing.length} turns.` }
    }

    if (arg !== 'print') {
      await $.ui.open({ id: PANE, title: 'Timeline' })

      return { text: 'timeline: pane opened' }
    }

    // Text form, for Remote Control and the desktop app, where panes do not reach.
    if (rows.length === 0) {
      return { text: 'timeline: nothing recorded yet.' }
    }
    const body = rows
      .map(r => {
        const lines = [`${r.isInjected ? '⏱' : '❯'} ${String(r.n).padStart(3)}  ${head(r.ask, 68)}`]
        const summary = r.anchor === undefined ? undefined : summaries[r.anchor]
        if (summary !== undefined) {
          lines.push(`      → ${summary}`)
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

    return { text: `timeline · ${rows.length} turns\n\n${body}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const messages = await $.session.messages()
    if ('deny' in messages) {
      return <Text dimColor>cannot read this session</Text>
    }

    const rows = rowsCached(messages)
    const width = Math.max(24, (e.viewport?.columns ?? 40) - 6)
    const unsummarised = rows.filter(r => r.anchor !== undefined && summaries[r.anchor] === undefined).length

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text dimColor>
          {rows.length} turns
          {unsummarised > 0 ? ` · ${unsummarised} unsummarised (/timeline fill)` : ''}
        </Text>
        {rows.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {rows.map(row => {
          const id = askIds.get(row.ask.replace(/\s+/g, ' ').trim().slice(0, 60)) ?? row.anchor
          const summary = row.anchor === undefined ? undefined : summaries[row.anchor]
          const mark = `${row.isInjected ? '⏱' : '❯'} ${row.n}`
          const headline = `${mark}  ${head(row.ask, width - mark.length - 2)}`

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
                  {summary}
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

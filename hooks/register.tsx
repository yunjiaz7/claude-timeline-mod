import type { Register, SessionMessage } from 'claude-code'

const PANE = 'timeline'

// A transcript row's own render id, which `$.ui.scroll` needs to reach it.
// Keyed by the text, since that is all a SessionMessage and a UserMessage row
// share. Rows restored from history are not drawn, so they get no id and no
// jump button — better than offering one that always fails.
const rowIds = new Map<string, string>()

function keyOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60)
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

type Row = { n: number; ask: string; isInjected: boolean; details: string[] }

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
    const errors: string[] = []

    for (const use of uses) {
      if (use.isError === true) {
        errors.push(use.text ?? 'failed')
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
      const names = files.slice(0, 6).map(f => f.split('/').pop())
      row.details.push(`${files.length} file(s): ${names.join(', ')}${files.length > 6 ? ' …' : ''}`)
    }
    if (cmds.length > 0) {
      row.details.push(`${cmds.length} command(s): ${tally(cmds, 5)}`)
    }
    if (other.length > 0) {
      row.details.push(tally(other, 5))
    }
    for (const err of errors.slice(0, 2)) {
      row.details.push(`⚠ ${head(err, 76)}`)
    }
    if (errors.length > 2) {
      row.details.push(`⚠ …and ${errors.length - 2} more error(s)`)
    }
    uses = []
  }

  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() !== '') {
      close()
      rows.push({ n: rows.length + 1, ask: m.text, isInjected: INJECTED.test(m.text), details: [] })
    } else if (m.role === 'assistant') {
      uses = [...uses, ...m.toolUses]
    }
  }
  close()

  return rows
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'timeline',
      description: 'What actually happened this session — pane, or `print` for text',
    })

    return next(e)
  })

  on('command.run', { command: 'timeline' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'timeline: closed' }
    }

    if ((e.args ?? '').trim() !== 'print') {
      await $.ui.open({ id: PANE, title: 'Timeline' })

      return { text: 'timeline: pane opened' }
    }

    // Text form, for Remote Control and the desktop app, where panes do not reach.
    const messages = await $.session.messages()
    if ('deny' in messages) {
      return { text: `timeline: cannot read this session (${messages.deny})` }
    }
    const rows = rowsOf(messages).filter(r => r.details.length > 0)
    if (rows.length === 0) {
      return { text: 'timeline: nothing recorded yet.' }
    }
    const body = rows
      .map(r => [`${r.isInjected ? '⏱' : '❯'} ${String(r.n).padStart(3)}  ${head(r.ask, 68)}`,
                 ...r.details.map(d => `      ${d}`)].join('\n'))
      .join('\n\n')

    return { text: `timeline · ${rows.length} turns\n\n${body}` }
  })

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const key = keyOf(e.props.text)
    if (key !== '') {
      rowIds.set(key, e.requestId)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const messages = await $.session.messages()
    if ('deny' in messages) {
      return <Text dimColor>cannot read this session</Text>
    }

    const rows = rowsOf(messages).filter(r => r.details.length > 0)
    const width = Math.max(24, (e.viewport?.columns ?? 40) - 6)

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text dimColor>{rows.length} turns that did something</Text>
        {rows.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {rows.map(row => {
          const id = rowIds.get(keyOf(row.ask))
          const label = `${row.isInjected ? '⏱' : '❯'} ${row.n}  ${head(row.ask, width)}`

          return (
          <Box key={`t${row.n}`} flexDirection="column" marginTop={1}>
            {id === undefined ? (
              <Text bold color={row.isInjected ? 'yellow' : 'cyan'} wrap="wrap">{label}</Text>
            ) : (
              <Button
                plain
                key={`j${row.n}`}
                onPress={() => {
                  void $.ui.scroll({ to: { requestId: id }, block: 'start' })
                }}
              >
                {label}
              </Button>
            )}
            {row.details.map((d, i) => (
              <Text key={`t${row.n}d${i}`} dimColor wrap="wrap">
                {'  '}
                {d}
              </Text>
            ))}
          </Box>
          )
        })}
      </Box>
    )
  })
}

import type { Register, SessionMessage } from 'claude-code'

const WRITES = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

// `cd x && python train.py` really ran `python train.py`, not `cd`.
// Found the hard way: without stripping the preamble every tally read `cd×N`.
const NOISE = new Set(['cd', 'export', 'source', 'set', 'unset', 'echo'])
const PREFIX = new Set(['timeout', 'nohup', 'sudo', 'env', 'time', 'nice', 'xargs', 'command'])
const KEEP_ARG = new Set(['python', 'python3', 'uv', 'npm', 'npx', 'git', 'bash', 'sh'])

export function verbOf(cmd: string): string | null {
  for (const part of cmd.split(/&&|\|\||;/)) {
    const words = part.trim().split(/\s+/).filter(Boolean)
    while (words.length > 0 && (PREFIX.has(words[0]) || words[0].includes('=') || /^\d+$/.test(words[0]))) {
      words.shift()
    }
    const first = words[0]
    if (first === undefined || NOISE.has(first)) {
      continue
    }
    const verb = first.split('/').pop() ?? first
    if (KEEP_ARG.has(verb) && words[1] !== undefined) {
      return `${verb} ${words[1].split('/').pop()}`
    }

    return verb
  }

  return null
}

// A turn the person did not type: a background task reporting, a slash command,
// the engine's own framing. They open a segment too, but read differently.
const INJECTED = /^\s*<(task-notification|command-name|local-command|system-reminder)/

function head(text: string, n = 68): string {
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

type Segment = { ask: string; isInjected: boolean; uses: SessionMessage['toolUses'] }

function segment(messages: readonly SessionMessage[]): Segment[] {
  const segs: Segment[] = []
  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() !== '') {
      segs.push({ ask: m.text, isInjected: INJECTED.test(m.text), uses: [] })
    } else if (m.role === 'assistant' && segs.length > 0) {
      segs[segs.length - 1].uses.push(...m.toolUses)
    }
  }

  return segs
}

function render(seg: Segment, index: number): string {
  const files: string[] = []
  const cmds: string[] = []
  const other: string[] = []
  const errors: string[] = []

  for (const use of seg.uses) {
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

  const lines = [`${seg.isInjected ? '⏱' : '❯'} ${String(index).padStart(3)}  ${head(seg.ask)}`]
  if (files.length > 0) {
    const names = files.slice(0, 6).map(f => f.split('/').pop())
    lines.push(`      ${files.length} file(s): ${names.join(', ')}${files.length > 6 ? ' …' : ''}`)
  }
  if (cmds.length > 0) {
    lines.push(`      ${cmds.length} command(s): ${tally(cmds, 5)}`)
  }
  if (other.length > 0) {
    lines.push(`      ${tally(other, 5)}`)
  }
  for (const err of errors.slice(0, 2)) {
    lines.push(`      ⚠ ${head(err, 76)}`)
  }
  if (errors.length > 2) {
    lines.push(`      ⚠ …and ${errors.length - 2} more error(s)`)
  }

  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'timeline',
      description: 'What actually happened this session, turn by turn',
    })

    return next(e)
  })

  on('command.run', { command: 'timeline' }, async ($, e) => {
    const messages = await $.session.messages()
    if ('deny' in messages) {
      return { text: `timeline: cannot read this session (${messages.deny})` }
    }

    // `/timeline 20` shows the last 20; bare shows the ones that did something.
    const limit = Number.parseInt(e.args ?? '', 10)
    const all = segment(messages)
    const shown = Number.isNaN(limit)
      ? all.filter(s => s.uses.length > 0)
      : all.slice(-Math.max(1, limit))

    if (shown.length === 0) {
      return { text: 'timeline: nothing recorded yet.' }
    }

    const body = shown.map(s => render(s, all.indexOf(s) + 1)).join('\n\n')

    return { text: `timeline · ${shown.length} of ${all.length} turns\n\n${body}` }
  })
}

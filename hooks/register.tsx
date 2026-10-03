import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Segment } from '../types'

const segments = atom({ plugin: 'timeline', key: 'segments' } as const, [])

const MAX_SEGMENTS = 400
const WRITES = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

// `cd x && python train.py` 的真正动词是 `python train.py`，不是 `cd`。
// 这条是 v0 脚本在真实数据上撞出来的：不剥前缀的话统计全是 cd。
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
    .map(([k, v]) => (v > 1 ? `${k}×${v}` : k))
    .join(', ')
}

function renderSegment(seg: Segment): string {
  const lines: string[] = []
  const mark = seg.origin === 'composer' || seg.origin === 'bridge' ? '❯' : '⏱'
  lines.push(`${mark} ${seg.at.slice(5, 16).replace('T', ' ')}  ${head(seg.prompt)}`)

  if (seg.files.length > 0) {
    const names = seg.files.slice(0, 6).map(f => f.split('/').pop())
    lines.push(`    改了 ${seg.files.length} 个文件: ${names.join(', ')}${seg.files.length > 6 ? ' …' : ''}`)
  }
  if (seg.cmds.length > 0) {
    lines.push(`    跑了 ${seg.cmds.length} 条命令: ${tally(seg.cmds, 5)}`)
  }
  const other = Object.entries(seg.tools)
    .filter(([name]) => name !== 'Bash' && !WRITES.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => (v > 1 ? `${k}×${v}` : k))
  if (other.length > 0) {
    lines.push(`    其他: ${other.join(', ')}`)
  }
  for (const err of seg.errors.slice(0, 2)) {
    lines.push(`    ⚠ ${head(err, 80)}`)
  }
  if (seg.errors.length > 2) {
    lines.push(`    ⚠ …另有 ${seg.errors.length - 2} 个报错`)
  }
  if (lines.length === 1) {
    lines.push('    (没动任何东西)')
  }

  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'timeline',
      description: '打印这个 session 的时间线（每段你发的话之后实际发生了什么）',
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const seg: Segment = {
      at: new Date(await $.clock.now()).toISOString(),
      prompt: e.text,
      origin: e.origin.kind,
      files: [],
      cmds: [],
      tools: {},
      errors: [],
    }
    await update($, segments, list => [...list, seg].slice(-MAX_SEGMENTS))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)

    // 结果回来了才记，这样同一处就能把报错一起收掉。
    await update($, segments, list => {
      if (list.length === 0) {
        return list
      }
      const seg = list[list.length - 1]
      const input = (e.input ?? {}) as Record<string, unknown>
      const updated: Segment = {
        ...seg,
        tools: { ...seg.tools, [e.tool]: (seg.tools[e.tool] ?? 0) + 1 },
        files: [...seg.files],
        cmds: [...seg.cmds],
        errors: [...seg.errors],
      }

      if (WRITES.has(e.tool)) {
        const path = (input.file_path ?? input.notebook_path) as string | undefined
        if (path !== undefined && !updated.files.includes(path)) {
          updated.files.push(path)
        }
      } else if (e.tool === 'Bash') {
        const verb = verbOf((input.command as string) ?? '')
        if (verb !== null) {
          updated.cmds.push(verb)
        }
      }

      if (result.isError === true && updated.errors.length < 20) {
        updated.errors.push(String(result.text ?? 'failed'))
      }

      return [...list.slice(0, -1), updated]
    })

    return result
  })

  on('command.run', { command: 'timeline' }, async $ => {
    const list = await read($, segments)
    if (list.length === 0) {
      return { text: '时间线还是空的 —— 这个 mod 加载之后还没发生过什么。' }
    }

    const body = list.map(renderSegment).join('\n\n')

    return { text: `时间线 · ${list.length} 段\n\n${body}` }
  })
}

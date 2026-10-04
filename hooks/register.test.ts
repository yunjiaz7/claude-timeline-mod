import { expect, test } from 'claude-code/testing'

import { rowsOf, verbOf } from './register'

// The bug real data exposed: commands are almost all `cd x && real`,
// so taking the first word tallied `cd×N` and said nothing.
test('verbOf skips cd preamble and finds the real command', () => {
  expect(verbOf('cd /x/y && python train.py --lr 1e-4')).toBe('python train.py')
  expect(verbOf('cd /x && ls')).toBe('ls')
})

test('verbOf strips timeout/nohup/sudo wrappers', () => {
  expect(verbOf('timeout 300 ssh gpu01 nvidia-smi')).toBe('ssh')
  expect(verbOf('nohup python3 run.py &')).toBe('python3 run.py')
})

test('verbOf keeps the script name after an interpreter', () => {
  expect(verbOf('git commit -m x')).toBe('git commit')
  expect(verbOf('/usr/bin/python3 /a/b/eval.py')).toBe('python3 eval.py')
})

test('verbOf returns null for pure preamble', () => {
  expect(verbOf('cd /tmp')).toBe(null)
  expect(verbOf('export FOO=1')).toBe(null)
})

// Real `/timeline` output showed junk like `p'×2`, `print([x['name']` and `-s`:
// multi-line commands with heredocs had their bodies tallied as commands.
test('verbOf ignores a heredoc body', () => {
  expect(verbOf("python3 - <<'EOF'\nprint([x['name'] for x in y])\nEOF")).toBe("python3")
  expect(verbOf('cat > f.md <<MD\nsome text\nMD')).toBe('cat')
})

test('verbOf skips flags to reach the subcommand', () => {
  expect(verbOf('git -c user.email=x commit -q -m msg')).toBe('git commit')
  expect(verbOf('curl -s https://api.github.com/x')).toBe('curl')
  expect(verbOf('gh repo create foo --private')).toBe('gh repo')
})

let nextId = 0
const use = (tool: string, input: Record<string, unknown>) =>
  ({ tool, input, tool_use_id: `toolu_${(nextId += 1)}` })

const msg = (role: 'user' | 'assistant', text: string, toolUses: unknown[] = []) =>
  ({ role, text, toolUses }) as never

test('rowsOf opens a row per sent message and attributes the work after it', () => {
  const rows = rowsOf([
    msg('user', 'run the ablation'),
    msg('assistant', 'ok', [
      use('Bash', { command: 'cd /x && python train.py' }),
      use('Write', { file_path: '/x/results.json' }),
    ]),
    msg('assistant', 'done', [use('Bash', { command: 'cat /x/results.json' })]),
    msg('user', '<task-notification> finished'),
  ])

  expect(rows.length).toBe(2)
  expect(rows[0].isInjected).toBe(false)
  expect(rows[0].details).toEqual([
    '1 file(s): results.json',
    '2 command(s): python train.py, cat',
  ])
  // An injected turn still opens a row, and reads differently.
  expect(rows[1].isInjected).toBe(true)
  expect(rows[1].details).toEqual([])
})

// The jump target is the turn's first tool row: its tool_use_id IS the row's
// requestId, so it comes straight from the transcript and covers history too.
test('rowsOf anchors a row to its first tool call', () => {
  nextId = 0
  const rows = rowsOf([
    msg('user', 'go'),
    msg('assistant', 'ok', [use('Bash', { command: 'ls' }), use('Bash', { command: 'pwd' })]),
    msg('user', 'just chatting'),
  ])

  expect(rows[0].anchor).toBe('toolu_1')
  expect(rows[1].anchor).toBe(undefined)
})


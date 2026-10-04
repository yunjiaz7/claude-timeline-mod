import { expect, test } from 'claude-code/testing'

import { cells, parseAsks, parseFill, resolveLanguage, resolveVerb, rowsOf, verbOf } from './register'

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
  expect(rows[0]!.isInjected).toBe(false)
  expect(rows[0]!.facts).toEqual([
    '1 file: results.json',
    '2 cmd: python train.py, cat',
  ])
  // An injected turn still opens a row, and reads differently.
  expect(rows[1]!.isInjected).toBe(true)
  expect(rows[1]!.facts).toEqual([])
  // Every turn gets a row now, talk-only ones included: a trajectory with
  // holes in its numbering is not a trajectory.
  expect(rows.map(r => r.key)).toEqual(['t1', 't2'])
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

  expect(rows[0]!.anchor).toBe('toolu_1')
  expect(rows[1]!.anchor).toBe(undefined)
})


// The fork is told to answer `<number>|<line>` and nothing else, but a model
// adds a preamble often enough that the parser has to simply ignore one.
test('parseFill keeps the numbered lines and drops everything else', () => {
  const parsed = parseFill([
    "Here's the summary:",
    '',
    '3|Read a past session|Wrote worklog.py and ran it over the 72MB research session',
    '  7 | Why is every command cd | Fixed verbOf: every tally had read cd×N',
    '## not a turn',
    '12|Add a render test|Gave up on it — the scaffolding outgrew the code',
  ].join('\n'))

  expect(Object.keys(parsed)).toEqual(['3', '7', '12'])
  expect(parsed[7]!).toEqual({ ask: 'Why is every command cd', did: 'Fixed verbOf: every tally had read cd×N' })
})

// A terminal lays out in cells: a Chinese headline cut by character count came
// out about twice the pane width and wrapped under its own number.
test('cells counts CJK as two and ASCII as one', () => {
  expect(cells('abc')).toBe(3)
  expect(cells('中文')).toBe(4)
  expect(cells('❯ 17 那我')).toBe(9)
})

// The asks are always there, even when the reply is not — a turn still running,
// or a resumed session with no thread to fork. An ask-only line beats no line.
test('parseAsks reads the two-field ask-only form', () => {
  const parsed = parseAsks(['Summary:', '4|改用 complete 只读单轮', '  9 | Ask why other sessions cannot see it'].join('\n'))

  expect(parsed[4]!).toBe('改用 complete 只读单轮')
  expect(parsed[9]!).toBe('Ask why other sessions cannot see it')
})

// A command you can only reach by spelling it exactly is one you keep looking up.
test('resolveVerb takes an exact word, a prefix, or a near miss', () => {
  expect(resolveVerb('fill')).toBe('fill')
  expect(resolveVerb('fil')).toBe('fill')
  expect(resolveVerb('rep')).toBe('replies')
  expect(resolveVerb('lng')).toBe('lang')
  expect(resolveVerb('langauge')).toBe('lang')
  expect(resolveVerb('')).toBe(null)
  expect(resolveVerb('xyzzy')).toBe(null)
})

test('resolveLanguage takes a name, a code, or a prefix', () => {
  expect(resolveLanguage('zh')).toBe('中文')
  expect(resolveLanguage('EN')).toBe('English')
  expect(resolveLanguage('中文')).toBe('中文')
  expect(resolveLanguage('esp')).toBe('Español')
  expect(resolveLanguage('klingon')).toBe(null)
})

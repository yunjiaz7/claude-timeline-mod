import { expect, test } from 'claude-code/testing'

import { cardOf, cells, chunksOf, costText, fitTop, parseAsks, parseFill, parseFind, pendingOf, resolveLanguage, resolveVerb, rowsOf, verbOf, wrapCells } from './register'

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
  expect(rows.map(r => r.n)).toEqual([1, 2])
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

test('pendingOf waits only on the newest row and summarises only a row with a reply', () => {
  const row = (body: string) => ({ ...rowsOf([{ role: 'user', text: 'hi', toolUses: [] }])[0]!, body })
  expect(pendingOf(row(''), true, false)).toBe('waiting…')
  expect(pendingOf(row(''), false, true)).toBe(null)
  expect(pendingOf(row('done'), false, true)).toBe('summarising…')
  expect(pendingOf(row('done'), false, false)).toBe(null)
})

test('chunksOf cuts a list into runs of the given size', () => {
  expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  expect(chunksOf([], 2)).toEqual([])
})

test('costText splits prompts from replies and keeps what was spent before the split', () => {
  const text = costText(
    { calls: 10, input: 9000, out: 900, quota: 0.2,
      asks: { calls: 3, input: 1000, out: 100 }, replies: { calls: 4, input: 5000, out: 600 } },
    true,
  )
  expect(text).toContain('prompts     3 calls · 1.0k in / 100 out · ≈ $0.002')
  expect(text).toContain('replies     4 calls · 5.0k in / 600 out · ≈ $0.008')
  expect(text).toContain('earlier     3 calls · 3.0k in / 200 out')
  expect(text).toContain('/timeline replies off')
  expect(costText({ calls: 0, input: 0, out: 0, quota: 0 }, true)).toContain('nothing spent')
})

test('wrapCells breaks at a space when it can and mid-word when it cannot', () => {
  expect(wrapCells('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  expect(wrapCells('汉字汉字汉', 6)).toEqual(['汉字汉', '字汉'])
  expect(wrapCells('short', 20)).toEqual(['short'])
  for (const line of wrapCells('  → 生成了约120字的详细段落 with some English words mixed in', 16)) {
    expect(cells(line) <= 16).toBe(true)
  }
})

test('a stray closing pipe is not part of the summary', () => {
  expect(parseFill('3|ask|did it|')[3]).toEqual({ ask: 'ask', did: 'did it' })
  expect(parseAsks('4|wanted this |')[4]).toBe('wanted this')
})

// After a compaction and a resume the session hands over only its tail. Keys
// made of the position then put an old turn's summary on a different turn.
test('a row keeps its key when the turns before it are gone', () => {
  const all = [msg('user', 'first ask'), msg('user', 'second ask'), msg('user', 'continue'), msg('user', 'continue')]
  const full = rowsOf(all)
  const tail = rowsOf(all.slice(1))
  expect(tail[0]!.n).toBe(1)
  expect(tail[0]!.key).toBe(full[1]!.key)
  expect(full[2]!.key).not.toBe(full[3]!.key)
})

test('parseFind keeps the order given, each number once, and only rows that exist', () => {
  expect(parseFind('12, 3, 12, 40', 20)).toEqual([12, 3])
  expect(parseFind('none', 20)).toEqual([])
  expect(parseFind('Turns 7 and 2.', 20)).toEqual([7, 2])
})

test('fitTop moves the first card only as far as it takes to show the one asked for', () => {
  const four = [4, 4, 4, 4, 4, 4]
  expect(fitTop(four, 0, 1, 12)).toBe(0)
  expect(fitTop(four, 0, 5, 12)).toBe(3)
  expect(fitTop(four, 4, 1, 12)).toBe(1)
  expect(fitTop([4, 30, 4], 0, 1, 12)).toBe(1)
})

test('cardOf reads the card off any of its lines and nothing off the search box', () => {
  expect(cardOf('j12')).toBe(12)
  expect(cardOf('d12.0')).toBe(12)
  expect(cardOf('f7.1')).toBe(7)
  expect(cardOf('find')).toBe(null)
  expect(cardOf('find-back')).toBe(null)
  expect(cardOf(undefined)).toBe(null)
})

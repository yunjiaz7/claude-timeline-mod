import { expect, test } from 'claude-code/testing'

import { verbOf } from './register'

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

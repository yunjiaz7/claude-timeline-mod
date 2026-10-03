import { expect, test } from 'claude-code/testing'

import { verbOf } from './register'

// 真实数据里撞出来的那个 bug：命令几乎都是 `cd xxx && 真命令`，
// 取第一个词的话统计全是 cd，日志完全没信息量。
test('verbOf 跳过 cd 铺垫，拿到真正干活的命令', () => {
  expect(verbOf('cd /x/y && python train.py --lr 1e-4')).toBe('python train.py')
  expect(verbOf('cd /x && ls')).toBe('ls')
})

test('verbOf 剥掉 timeout/nohup/sudo 这类前缀', () => {
  expect(verbOf('timeout 300 ssh gpu01 nvidia-smi')).toBe('ssh')
  expect(verbOf('nohup python3 run.py &')).toBe('python3 run.py')
})

test('verbOf 带参数的解释器保留第二个词', () => {
  expect(verbOf('git commit -m x')).toBe('git commit')
  expect(verbOf('/usr/bin/python3 /a/b/eval.py')).toBe('python3 eval.py')
})

test('verbOf 纯铺垫命令返回 null', () => {
  expect(verbOf('cd /tmp')).toBe(null)
  expect(verbOf('export FOO=1')).toBe(null)
})

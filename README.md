# timeline

一个 Claude Code mod：把 session 读成**时间线** —— 每段你发的话之后，*实际发生了什么变化*。

不是对话目录（谁说了什么），是工作日志（动了什么）。为无人值守的长跑设计：
auto research 跑一夜，早上扫一眼就知道发生了什么。

## 用

```
/timeline
```

打印成一条对话消息，所以 Remote Control / 桌面端也看得见（面板不行）。

```
❯ 10-03 14:22  帮我跑一下 C2 那组实验
    跑了 26 条命令: ssh×22, python3 train.py×3, cat×1
    其他: Monitor, CronCreate
    ⚠ Exit code 1  CUDA out of memory
```

`❯` 是你亲手发的，`⏱` 是定时任务 / 后台注入的。

## 历史 session

mod 只看它加载之后的事。要读以前的：

```bash
python3 scripts/timeline_past.py ~/.claude/projects/<项目>/<session>.jsonl \
  --since=2026-09-05 --min-tools=4
```

## 开发

```bash
claude plugin validate .
claude plugin test .
```

热重载开着的话，改完文件下一轮就生效。

## 状态

v0。刻意没做：LLM 生成每段标题、面板、多 session 聚合、落盘。
等「内容形态对不对」验证完再加 —— 先用，再迭代。

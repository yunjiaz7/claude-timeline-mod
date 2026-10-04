# timeline

A Claude Code mod that reads a session as **what actually happened** — for each
turn, the files touched, the commands run, the errors hit.

Not a table of contents (who said what). A work log (what changed). Built for
unattended long runs: let an auto-research loop go overnight, read one screen in
the morning.

## Use

```
/timeline         # open the pane (docks right of the transcript)
/timeline print   # same thing as a message
/timeline close
```

The pane is a terminal surface. Remote Control and the desktop app do not render
plugin panes, so `print` is the form that reaches them.

```
❯  42  run the C2 ablation on the idle GPU
       26 command(s): ssh×22, python3 train.py×3, cat×1
       Monitor, CronCreate
       ⚠ Exit code 1  CUDA out of memory

⏱  43  <task-notification> run finished
       4 command(s): scp×2, cat×2
```

Each card ends in `⤴ jump`, which scrolls the transcript to that turn. It aims at the message
itself where that row has been drawn, and otherwise at the turn's first tool
row, whose requestId is its tool_use_id — read straight from the transcript,
so turns from before the mod was installed jump too.

Rows are derived from the whole transcript, so the walk is cached and redone
only when the transcript grows.

`❯` is a turn you typed. `⏱` is one injected — a background task reporting, a
scheduled trigger, a slash command.

It reads the session transcript on demand, so it covers turns from before the
mod was installed. Nothing is accumulated, nothing is stored.

## Past sessions

For a session that is no longer open:

```bash
python3 scripts/timeline_past.py ~/.claude/projects/<project>/<session>.jsonl \
  --since=2026-09-05 --min-tools=4
```

## Develop

```bash
claude plugin validate .
claude plugin test .
```

With hot reloading on, an edit lands on the next turn.

A tree that does not validate is refused at render time, not by `validate`, and
the pane goes blank. The engine says why on a dim transcript line
(`timeline: ui.render hook skipped: …`) — read that before guessing.

## Status

v0. Deliberately absent: model-written titles per segment, a live pane,
cross-session rollup, writing to disk. Each waits until using it proves the
shape is right.

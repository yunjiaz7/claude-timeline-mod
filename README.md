# timeline

A Claude Code mod that reads a session as **what actually happened** — for each
turn, the files touched, the commands run, the errors hit.

Not a table of contents (who said what). A work log (what changed). Built for
unattended long runs: let an auto-research loop go overnight, read one screen in
the morning.

## Use

```
/timeline         # open the pane (docks right of the transcript)
/timeline fill    # summarise the turns that have none yet
/timeline print   # same thing as a message
/timeline close
```

```
❯ 42  run the C2 ablation on the idle GPU
      → Queued three runs at lr 1e-4/3e-4/1e-3; best val acc 0.83 at 3e-4
      26 cmd: ssh×22, python3 train.py×3 · Monitor, CronCreate
      ⚠ Exit code 1  CUDA out of memory
```

`❯` is a turn you typed, `⏱` one injected — a background task reporting, a
scheduled trigger, a slash command. The headline is the control: press it and
the transcript scrolls to that turn. It aims at the message itself where that
row has been drawn, and otherwise at the turn's first tool row, whose
requestId is its tool_use_id — read straight from the transcript, so turns
from before the mod was installed jump too.

The pane is a terminal surface. Remote Control and the desktop app do not
render plugin panes, so `print` is the form that reaches them.

## Summaries

`fill` runs one `$.model.fork` — a completion over this session's own
transcript, so the model reads what it actually did, not a description of it,
and the API serves the prefix from cache. Every missing turn goes in that one
call: the cached-prefix read is the expensive part, so amortizing it over all
of them costs a fraction of one call per turn (~20x on a 150k-token session).
Results are stored per session and never recomputed.

It is never automatic. A fork is cheap only while the prefix is cached — after
an hour idle, or a `/model` switch, the same call costs about ten times as
much — so it runs when you ask and not before.

What the model writes sits beside what the transcript recorded, never instead
of it: the command tally stays, and an error is printed as the tool reported
it. A summary of a failure reads "addressed the issue" far too easily.

## Rows are derived

Rows come from walking the whole transcript, so the walk is cached and redone
only when the transcript grows. Nothing is accumulated as you work.

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

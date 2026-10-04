# timeline

```
claude plugin marketplace add yunjiaz7/claude-timeline-mod
claude plugin install timeline@claude-timeline-mod
```

Or point `CLAUDE_CODE_PLUGIN_DIRS` at a folder holding a clone, which is what
to do while editing it.


A Claude Code mod that reads a session as **what actually happened** — for each
turn, the files touched, the commands run, the errors hit.

Not a table of contents (who said what). A work log (what changed). Built for
unattended long runs: let an auto-research loop go overnight, read one screen in
the morning.

## Use

```
/timeline help    # every command, and what the settings are now
/timeline         # open the pane (docks right of the transcript)
/timeline fill    # summarise the turns that have none yet
/timeline close
```

```
❯ 42  Run the C2 ablation on a free GPU
      → Queued three runs at lr 1e-4/3e-4/1e-3; best val acc 0.83 at 3e-4
      26 cmd: ssh×22, python3 train.py×3 · Monitor, CronCreate
      ⚠ Exit code 1  CUDA out of memory
```

Every turn gets a row, talk-only ones included — a trajectory with holes in
its numbering is not a trajectory. The headline is the ask as the model read
it (the point of the turn, not its wording); press it to go read what you
actually wrote.

`❯` is a turn you typed, `⏱` one injected — a background task reporting, a
scheduled trigger, a slash command. The headline is the control: press it and
the transcript scrolls to that turn. It aims at the message itself where that
row has been drawn, and otherwise at the turn's first tool row, whose
requestId is its tool_use_id — read straight from the transcript, so turns
from before the mod was installed jump too.

## Surfaces

`$.ui.open` reports whether the pane was actually placed, so `/timeline` draws
a pane where one can be drawn and prints the same rows inline where one cannot
— naming the reason rather than claiming a pane nobody can see. There is no
separate print command: the only case that needed one is the case that answers
itself.

| Surface | Pane |
|---|---|
| Terminal (>=110 cols) | yes |
| Desktop app hosting its own session | yes |
| Desktop / iOS **viewing a session over Remote Control** | no — [#99217](https://github.com/anthropics/claude-code/issues/99217) |
| VS Code extension | no — [#99045](https://github.com/anthropics/claude-code/issues/99045) |
| Mobile | no (reports `isFullscreen: false`) |

The engine is surface-agnostic: its `ui_render` accepts `desktop`, `mobile` and
`vscode`, and `$.ui.resolve(e)` hands each surface its own element table. The
gap is on the client side — a Remote Control viewer and the VS Code webview
never attach as a render surface, so nothing a mod draws is requested from
them. Both are open bugs; nothing a mod can do reaches those views today
except its text.

## What a row shows, and when

A prompt lands instantly and a reply does not, so a row never waits on the
slower half:

| | Row shows |
|---|---|
| No summary written — a call failed, or none has run yet | your prompt, verbatim |
| Ask summarised | what you wanted, and `→ summarising…` while a call runs, `→ waiting…` until one does |
| Reply summarised | what you wanted, and what it did |

Each step carries more than the last and none of them blocks. The ask is
always written first, in its own short call, and the pane is redrawn the
moment it lands — a row never sits showing its raw prompt while the turn it
opened is still running. The reply pass follows in the same run, over the rows
the ask pass just created, so a row reaches its full form without waiting for
anything else to happen.

## Summaries

`fill` runs one `$.model.fork` — a completion over this session's own
transcript, so the model reads what it actually did, not a description of it,
and the API serves the prefix from cache. Every missing turn goes in that one
call: the cached-prefix read is the expensive part, so amortizing it over all
of them costs a fraction of one call per turn (~20x on a 150k-token session).
Each turn gets both halves — what you asked and what it did — and results are
stored per session and never recomputed. `fill` reports what the call cost:
`120.4k cached + 1.1k fresh in, 0.6k out`. A `cache_read` smaller than the
fresh input means the prefix had lapsed and that fork paid full price for the
transcript.

It fills itself from the draw: drawing the pane is the signal that someone is
reading it, and the only one that holds across a reload, a reopen and a new
turn alike. The tree goes back immediately with the asks as written and the
summaries land on the redraw the fill triggers, so nothing waits on a model.
With the pane closed nothing is drawn and nothing is spent — a session can run all night unattended
and cost nothing until you open the pane in the morning, which then summarises
the whole night in one fork.

Every call is `$.model.complete` on Haiku, which carries no history and reads
only what it is handed — the ask alone for a row with no summary yet, the turn
with its reply for one being upgraded — and takes an explicit output cap.

Batches are chunked so a reply always fits that cap. A fork was used for them
once and is not any more: it takes no cap, so one answering 61 rows ran past
the default, lost every line after it, counted those rows as failures and
re-read the whole cached prefix to fail again — 33 calls and two million
tokens for a timeline that stayed unwritten. It is also what the measured cost
argued against: 3.8k tokens for 118 asks, against 414k for one fork.

Both report what they took: elapsed time, tokens, and the share of the
five-hour window the call moved, which is what a subscription actually
spends. The pane header carries the running total, and `/timeline fill`
forces a fill by hand.

What the model writes sits beside what the transcript recorded, never instead
of it: the command tally stays, and an error is printed as the tool reported
it. A summary of a failure reads "addressed the issue" far too easily.

## Turning the reply side off

```
/timeline replies off
/timeline replies on
/timeline replies          # what it is now
```

or the `Summarise replies` row in `/config`. With it off a row keeps its ask
summary and its tally of files and commands, and nothing is called for the
reply side: the list of rows to upgrade is built empty, so the loop that would
call the model has nothing to iterate. Rows already written are kept, and
turning it back on fills in what is missing.

## Language

```
/timeline lang          # what it is now, and the choices
/timeline lang 中文
```

or the `Summary language` row in `/config`, which is the same setting — a
mod's options belong in the one menu that lists every mod's, and a mod with
its own command should answer for its own setting too. Both write the row.
They are written in that language whatever language the turn itself is in, so
a session that mixes two reads as one.

Changing it reloads the mod, and the stored summaries no longer match, so they
are dropped and the next fill rewrites them — one call, not one per turn.

## Rows are derived

Rows come from walking the whole transcript, so the walk is cached and redone
only when the transcript grows. Nothing is accumulated as you work.

A reload empties the module's own variables — the store survives it, the
in-memory copy does not — so every path that reads summaries loads them first,
drawing included. A path that trusts another to have loaded them shows an
empty timeline after the next reload, with the data still on disk.

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

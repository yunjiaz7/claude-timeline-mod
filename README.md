# Timeline for Claude Code

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that
turns a long session into a navigable timeline: a pane beside the transcript
with one card per turn — what you asked, what Claude did, which files and
commands it touched, and any errors. Click a card to jump to that turn.

Built for long sessions: an overnight auto-research loop, a conversation of
hundreds of turns, several sessions in several terminals. Read one screen
instead of scrolling for minutes.

![Timeline demo: cards appear beside the transcript, each line is explained, a search jumps to a turn](docs/demo.gif)

Full-resolution video:

https://github.com/user-attachments/assets/a2313dc7-06c0-4b59-8e63-0df1b1a0d42f

## Install

Requires Claude Code v2.1.287 or later (the first version with mods).

In Claude Code:

```
/plugin marketplace add yunjiaz7/claude-timeline-mod
/plugin install timeline@claude-timeline-mod
```

The install screen shows the summary language and whether to summarise
replies; choose **Install for you**, then **Save configuration** to keep the
defaults. The mod is active at once: `/timeline` opens the pane, and the same
command closes it. In a brand-new session, send a prompt first.

Or from a terminal:

```bash
claude plugin marketplace add yunjiaz7/claude-timeline-mod
claude plugin install timeline@claude-timeline-mod
```

Then start a session, or run `/reload-plugins` in one that is already open.

## What you get

- **One card per turn**, numbered in order, talk-only turns included.
  - The title is your ask, summarised in one line as soon as you send it.
  - `→` is what Claude did, written when the turn ends.
  - The grey line counts what the transcript recorded: files written, commands
    run, other tools. No model is involved in it.
  - `⚠` lines are errors exactly as the tool reported them, never summarised.
- **Click anywhere on a card** to scroll the transcript to that turn.
- **The card for the turn on screen is marked** and follows as you scroll the
  transcript; a new prompt moves the mark to its card.
- **Search by meaning** in the box at the top: describe the turn you remember,
  in any words or language, and press Enter. Results are shown best first;
  `[ back to timeline ]` returns to every card.
- **Keyboard**: with the pane focused (click it), ↑ ↓ move between cards and
  Enter jumps.
- **Usage line** at the top: how much of the context window and of the 5-hour
  and 7-day rate windows is used. A figure turns to the warning colour past
  80% and to the error colour past 95%.
- **Every colour comes from your Claude Code theme**, so the pane reads the same
  in light and dark themes and in any terminal.

## Commands

| Command | What it does |
|---|---|
| `/timeline` | Open the pane, or close it if it is open |
| `/timeline find` | Hide or show the search box (shown by default) |
| `/timeline find <words>` | Search right away |
| `/timeline fill` | Summarise every turn that has no summary yet, now |
| `/timeline cost` | What the summaries in this session have cost |
| `/timeline lang [name]` | Show or set the summary language |
| `/timeline replies on\|off` | Write the "what Claude did" line, or summarise only your asks |
| `/timeline help` | All commands and the current settings |

A near miss is accepted: `/timeline fil`, `/timeline lng`.

Settings are also in `/config`: **Summary language** (English, Chinese,
Japanese, Spanish, French, German) and **Summarise replies**.

## Where it draws

| Where you run Claude Code | Pane |
|---|---|
| A terminal, including an editor's integrated terminal | yes |
| The Code tab of the Claude Desktop app | yes |
| The VS Code extension's chat panel, `claude -p`, a session viewed over Remote Control | no: `/timeline` prints the timeline as text instead |

## Cost

Summaries are written by Haiku on your own Claude account.

- **Nothing is spent while the pane is closed.** A session can run all night
  and cost nothing until you open the pane, which then catches up in one pass.
- Each summary is written once and stored; it is never recomputed.
- Asks are cheap: in one measured session, 118 asks took 3.8k input and 1.9k
  output tokens, 0.0% of the 5-hour window. Reply summaries read more (an
  excerpt of each reply) and cost more.
- `/timeline cost` shows the split between asks, replies and searches, in
  tokens, an estimate at Haiku's list price, and the share of the 5-hour window.
- `/timeline replies off` stops all spending on reply summaries.
- A search is one call, and only when you run one.

## Data and privacy

- **What is sent, and where.** Only to Anthropic's API through your own Claude
  Code session (`$.model.complete`), and only while the pane is open or when
  you run `/timeline fill` or a search:
  - for an ask: the start and end of your prompt, at most 560 characters;
  - for a reply: at most 6,000 characters per turn, made of up to 1,500
    characters of each reply message plus the first line (up to 120
    characters) of each tool call's command or file path;
  - for a search: each card's summary and a short excerpt of its prompt, plus
    your query.
- **Nothing else leaves the process.** The mod uses no network, file-system,
  process or environment access of its own; `claude plugin validate` lists
  every capability it calls.
- **What is stored, and where.** In Claude Code's plugin store on your machine
  (`~/.claude/plugins/store/timeline_*.json`), per session: the summaries, the
  token counts, the summary language, and jump targets. The first 60
  characters of each prompt are used as the lookup key, so they are stored in
  plain text. The store holds 4 MiB in all; when it is full, the least recently
  used sessions are removed. Delete the file to clear everything.
- **Summaries are a model's reading.** Text in the conversation can influence
  what a summary says. The file and command counts and the error lines come
  straight from the transcript and are not affected.

## Performance

With the pane closed the mod does no work. With it open, following the
transcript costs a little CPU while you scroll, because Claude Code has no
event for "the transcript scrolled": the mod reads the positions transcript rows
report as they are drawn, and checks again shortly after a scroll stops. While
the newest turn is on screen it skips those checks entirely.

## Troubleshooting

- **The pane is blank.** Claude Code refused the tree the mod drew; a dim line in
  the transcript (`timeline: ui.render …`) says why. Please open an issue with it.
- **A card keeps showing your raw prompt.** Its summary call failed or has not
  run yet. It is retried quietly; `/timeline fill` forces it.
- **`Unknown command: /timeline`** right after installing from a terminal or
  with `!claude plugin install`: run `/reload-plugins`, or start a new session.
- **`/timeline` only says "nothing recorded yet".** The session has no prompts
  yet; send one, then run `/timeline` again.
- **Nothing happens on `/timeline`.** Check that `/plugin` lists `timeline` and
  that Claude Code is v2.1.287 or later.

## Develop

```bash
git clone https://github.com/yunjiaz7/claude-timeline-mod
claude --plugin-dir ./claude-timeline-mod
```

`--plugin-dir` loads the clone for one session and reloads it when you save.
To load it in every session, add the clone's parent folder to
`CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.

Once the mod has loaded, Claude Code writes the API types for your build to
`.claude-plugin/types/` (not committed), which `tsconfig.json` uses:

```bash
npx -p typescript tsc -p . --noEmit   # types
claude plugin validate .              # manifest, hooks and capabilities
claude plugin test .                  # unit tests
```

All the mod's code is in `hooks/register.tsx`; `types/index.d.ts` declares its
plugin state.

## License

[MIT](LICENSE)

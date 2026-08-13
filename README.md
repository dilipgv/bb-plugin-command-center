# bb-plugin-inbox

The Captain's command center. Two lanes running in opposite directions through
one panel:

- **Needs you** — questions, review requests and FYIs that agents raised with
  `bb inbox ask` / `bb inbox review`. Answers are delivered back into the asking
  thread durably, and an answer you take back reaches the agent as an explicit
  `CORRECTION`.
- **Queue** — work *you* write down, dispatched to Chief when you say so. Chief
  routes it to the owning project chief, which creates the task and hands it to
  an architect. Requests are never dispatched automatically.

## Voice

Speak instead of typing. `⌥V` toggles the mic anywhere in the panel, or click
the mic on the composer or on any question card.

Voice always fills the form and stops — it never queues, dispatches or answers
on its own, because acting on a mishearing is worse than one extra tap.

A spoken request may carry its own metadata:

```
"bump the MCP SDK to 2.1, high priority, dispatch"
"in mcp micros, fix the cloudId fallback, urgent"
"look into the memory leak, details: only after a long session"
"queue up a task to review the PR backlog"
```

Modifiers are recognised only at the edges of what you said, so
"fix the urgent care banner" stays a title and does not become urgent.
Recognised: `urgent`, `high/low priority`, `in <project>`, `dispatch` /
`send to chief`, and `details:` to split a note off the title.

On a question card the mic dictates a text answer, or matches what you said
against the offered options — including `yep`/`nope` for yes/no, and several
options at once on a multi-select. The match is preselected for you to confirm;
if nothing clearly wins, it asks you to pick.

Check the grammar without a microphone:

```
bb inbox voice-parse "bump the SDK, high priority, dispatch"
```

Voice needs transcription configured on the server
(`voiceTranscriptionEnabled`); the mics hide themselves and the panel explains
why when it is not.

## CLI

```
bb inbox ask --task "Release 2.4" --question "Ship now or wait?" \
  --option "Ship now" --option "Wait" --asked-by "worker: release"
bb inbox review --task "ENG-42" --question "Skim the approach?" --thread thr_x
bb inbox list [--all]            # the question queue
bb inbox wait <id>               # block until answered
bb inbox snooze <id> --hours 4

bb inbox add "<title>" [--body … --project … --priority … --urgent]
bb inbox queue [--all]           # the request lane
bb inbox ack <id> --task-key ABC-12
bb inbox close <id> --outcome "Shipped in PR #412"
```

Agents get the same surface through the bundled `user-inbox` skill.

## Data

`items` (questions) and `requests` (the command center lane) live in this
plugin's own SQLite at `<dataDir>/plugins/inbox/data.db`. The first twelve
migrations reconstruct the `items` schema exactly as it shipped before this
rebuild, so an existing database is adopted untouched — **append new migrations
only at the end, never edit a shipped one.**

## Integration with Chief

`chief-nav` owns the Chief org. This plugin asks it where Chief lives
(`state` rpc) and falls back to the `chiefThreadId` setting, and chief-nav reads
this plugin's `list` rpc for its "waiting on the Captain" rail. Each tolerates
the other being absent; the `list` output shape is a contract — add fields, never
rename them.

## Develop

```
bb plugin install .          # register this directory
bb plugin reload inbox       # after editing
bb plugin dev                # watch: rebuild + reload on save
npx tsc --noEmit             # typecheck
bb plugin types              # refresh types/ from the running BB
bb plugin logs inbox -f
```

`components/ui/` is vendored shadcn source you own; add more with
`npx shadcn add @bb/select`. React, the radix portal primitives and `sonner` are
provided by the BB app at runtime and never bundled.

`types/bb-plugin-sdk.d.ts` is the full BB plugin API as readable declarations —
open it for exact signatures rather than guessing. BB source:
<https://github.com/get-bb/bb>.

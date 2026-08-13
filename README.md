# bb-plugin-command-center

The Captain's command center, and the Chief org behind it — one plugin, merged
from the former `inbox` and `chief-nav`.

Two lanes run in opposite directions through the board:

- **Needs you** — questions, review requests and FYIs that agents raised with
  `bb inbox ask` / `bb inbox review`. Answers are delivered back into the asking
  thread durably, and an answer you take back reaches the agent as an explicit
  `CORRECTION`.
- **Queue** — work *you* write down, dispatched to Chief when you say so. Chief
  routes it to the owning project chief, which creates the task and hands it to
  an architect. Requests are never dispatched automatically.

## Shortcuts

| Keys | Does |
| --- | --- |
| `⌥V` | Start / stop voice capture |
| `⌥D` | Toggle the detail box and focus it |
| `⇧Enter` | (in the title) open the detail box |
| `Enter` | Queue the request |
| `⌘Enter` | Dispatch to Chief (works from the detail box too) |
| `Esc` | (in the detail box) back to the title |

BB's keyboard settings only accept BB's own built-in commands, so a plugin
cannot register there. The two plugin-owned shortcuts are settings instead:

```
bb plugin config command-center set detailShortcut "mod+shift+d"
bb plugin config command-center set voiceShortcut "alt+space"
```

Accepted form is `modifier+…+key`, using `alt`/`opt`, `shift`, `ctrl`,
`cmd`/`meta`, or `mod` (⌘ on Apple, Ctrl elsewhere), plus a letter, digit, or
named key (`space`, `enter`, `slash`, …). At least one modifier is required so a
binding cannot fire while you type. Matching is by physical key, so ⌥-combos
work despite macOS emitting `∂`/`√` for them.

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
`send to chief`.

Saying `details`, `context`, `notes` or `background` splits everything after it
into the detail box — with or without the punctuation dictation may not produce.
Because an unpunctuated split is ambiguous, it only happens when what follows is
a clause of its own (four words or more) and the marker is not part of a noun
phrase, so "update the notes page for the new API" stays one title.

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

## Chief

`bb inbox chief …` is Chief's whole surface (`status`, `start`, `adopt`,
`project-chief`, `adopt-project-chief`, `handoff`, `retire`, `tidy`). It lives
under `bb inbox` because **a plugin may register only one top-level CLI
command** — merging cost `bb chief` as a name, not as a capability. The agent
tools (`chief_project_chief`, `chief_handoff`, `chief_roster`) and the three
Chief skills are unchanged.

The Chief panel keeps its own nav entry: the board is the work, that panel is who
is doing it.

## Data

`items` (questions), `requests` (the command center lane) and Chief's own
`chief`/`project_chiefs`/`architects` tables share one SQLite at
`<dataDir>/plugins/command-center/data.db`. The first twelve
migrations reconstruct the `items` schema exactly as it shipped before the
rebuild, and Chief's eight follow at 17–24 because both halves now share one
file — **append new migrations only at the end, never edit or reorder a shipped
one.**

## Layout

- `server.ts` / `app.tsx` — the command center: board, queue, questions, voice.
- `chief/` — the Chief org, merged in from `chief-nav`. It registers its own rpc,
  settings, agent tools, events and panel; the host module owns the shared
  database, the single CLI, and dispatching a request into Chief's thread.
- `lib/`, `hooks/` — pure logic (voice grammar, shortcut parsing) and React
  hooks, both unit-testable without a server.

The two halves used to talk over cross-plugin rpc. They are now direct calls:
Chief's needs-input rail reads the Inbox's open items through a callback, and the
dispatcher reads Chief's thread from its own table.

## Tasks

The Tasks plugin stays the durable substrate — it owns task keys (which Chief's
handoff contract requires), delivers comments to whoever is working a task, and
outlives the threads. You should never have to open it: every card mirrors what
it holds.

## Develop

```
bb plugin install .          # register this directory
bb plugin reload command-center       # after editing
bb plugin dev                # watch: rebuild + reload on save
npx tsc --noEmit             # typecheck
bb plugin types              # refresh types/ from the running BB
bb plugin logs command-center -f
```

`components/ui/` is vendored shadcn source you own; add more with
`npx shadcn add @bb/select`. React, the radix portal primitives and `sonner` are
provided by the BB app at runtime and never bundled.

`types/bb-plugin-sdk.d.ts` is the full BB plugin API as readable declarations —
open it for exact signatures rather than guessing. BB source:
<https://github.com/get-bb/bb>.

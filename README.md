# bb-plugin-command-center

The Captain's command center, and the Chief org behind it — one plugin, merged
from the former `inbox` and `chief-nav`.

The board runs Queue → In progress → In review → Done, with a derived Needs you
lane. Moving a card into **Done is deliberately manual** — signing work off is
the Captain's call, so agents park finished work in In review with
`bb inbox ready <id>` (or by setting the task to `in_review`) and stop there.
A review request (`bb inbox review …`) lands in In review too, since "look at
this PR" and "read this doc" are sign-off, not a decision blocking an agent.

Two lanes run in opposite directions through the board:

- **Needs you** — questions, review requests and FYIs that agents raised with
  `bb inbox ask` / `bb inbox review`. Answers are delivered back into the asking
  thread durably, and an answer you take back reaches the agent as an explicit
  `CORRECTION`.
- **Queue** — work *you* write down, dispatched to Chief when you say so. Chief
  routes it to the owning project chief, which creates the task and hands it to
  an architect. Requests are never dispatched automatically.

## Harness and model

The composer carries two selectors: which **harness** (provider) the work runs
on, and which **model** of that harness. Both are optional — leaving them at
"Default harness" lets BB choose as it always has.

The selector *is* the default: whatever is showing is what the next request runs
on, and changing it is remembered (in plugin kv, not a setting, because the
harness list is discovered from the host and a `select` setting needs static
options). Switching harness clears the model, since a model belongs to one
harness.

The choice is honoured in two places, deliberately belt-and-braces:

1. The dispatch brief tells Chief which harness and model the Captain picked.
2. `chief_handoff` takes optional `providerId`/`model`, and **when they are
   omitted it falls back to the card's choice, then the remembered default** —
   so the pick survives Chief forgetting to pass it on. The tool reports what it
   actually spawned on.

Discovery comes from `providers.list()` plus `providers.models({ providerId })`
per provider, cached for a minute because each is a host round trip.

## The reading view

Clicking a card's title opens it at `…/inbox/<cardId>` — a document, not a modal:
deep-linkable, browser-back returns to the board, and on a phone it is a page.

**Everything starts collapsed.** A card can carry 90,000 characters across two
dozen updates, so the page opens as a scannable table of contents — request,
outcome, each update with its author, time, size and first line — and you expand
what you came for. Expanding renders full Markdown: headings, tables, code.

Artifacts sit at the top: pull requests come from the Tasks plugin, and
everything else is mined out of the prose the card already carries, because
that is where agents actually leave links. Confluence links are named by their
page title, draft state or space rather than all reading "Confluence page".

The board's own click-through still opens the quick dialog for answering and
commenting; the title opens the reading view.

## Archiving

Every card has an archive control (the tile's hover icon, or the button in the
reading view). Archiving is **local to this plugin** — it never rewrites a BB
task's status — and reversible from `Archived` at the foot of the board.

One special case: archiving a **question** also dismisses it. A question card
hides an agent that is still waiting, so putting it away silently would block
that agent forever; dismissing tells the asker to proceed.

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

## Sidebar badge

The Command Center row in the app sidebar carries a count of what is waiting on
you. BB has no API for this — `navPanel` takes no badge and the host renders
plugin rows without one — so `nav-badge.ts` is a **content script**: page code
that finds the row and appends a span. It runs while any bb window is open, not
only while the panel is in view.

Two consequences are handled in that file rather than assumed away: the row is
React-owned, so every poll re-asserts the badge instead of trusting it survived a
re-render; and matching the row by its label has to strip a trailing number,
because otherwise our own digits stop it matching next time. It reads one cheap
`attention` rpc (a single `COUNT`), never the board.

## Notifications

macOS banners when something needs you or a card moves. bb has no native OS
notifications, so this plugin sends them itself.

```
bb inbox notify-test                                   # check the OS lets them through
bb plugin config command-center set notify off         # off | important | all
bb plugin config command-center set notifySound true
```

`important` (the default) notifies on a new question or review request, and when
a card reaches **In review**, **Needs you** or **Done**. `all` adds every other
lane change. Urgent questions always play a sound.

Two deliberate choices. It runs in the **backend**, not the panel, because on
macOS bb keeps running with its window closed — a frontend notifier would go
quiet exactly when you are working elsewhere. And the first sweep after install
only *records* state, so adopting an existing board does not fire a banner per
card. More than four changes in one sweep collapse into a single summary.

Sent via `osascript`, so macOS attributes them to **Script Editor** — if nothing
appears, allow it under System Settings → Notifications.

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

> `~/.bb/plugins/inbox/` is **not live**. It is the pre-merge database from when
> this plugin's id was `inbox`, left in place as a backup after the rename. The
> live data is `~/.bb/plugins/command-center/data.db`. Delete the old directory
> once you are confident nothing is missing.

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

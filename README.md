# bb-plugin-command-center

![Board](docs/screenshots/board.png)

The Captain's command center: a board of everything in flight and the
questions waiting on you. It dispatches work to Chief — the org of one global
Chief, a project chief per project, and task architects beneath them — which
lives in this same plugin, so there is nothing else to install.

The board runs Queue → In progress → In review → Done, with a derived Needs you
lane. Moving a card into **Done is deliberately manual** — signing work off is
the Captain's call, so agents park finished work in In review with
`bb command-center ready <id>` (or by setting the task to `in_review`) and stop there.
A review request (`bb command-center review …`) lands in In review too, since "look at
this PR" and "read this doc" are sign-off, not a decision blocking an agent.

Two lanes run in opposite directions through the board:

- **Needs you** — questions, review requests and FYIs that agents raised with
  `bb command-center ask` / `bb command-center review`. These are lightweight
  notifications, not a form: there's nothing to pick or type on the card
  itself — open the thread and reply there, same as any other conversation,
  then dismiss the card once it's handled.
- **Queue** — work *you* write down, dispatched to Chief when you say so. Chief
  routes it to the owning project chief, which creates the task and hands it to
  an architect. Requests are never dispatched automatically.

## Default project

The composer's project picker starts on the `defaultProject` setting
(`bb plugin config command-center set defaultProject <id>`) instead of an
empty "pick automatically" placeholder. Picking a different project for one
request does not change the setting — it only affects that request.

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
   omitted it falls back to the card's choice, then the remembered
   default** — read internally via `dispatchPreferenceFor` — so the pick
   survives Chief forgetting to pass it on. The tool reports what it actually
   spawned on.

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

A question card's own buttons (open the thread or link, dismiss, snooze) work
straight from the board tile; the title opens the reading view for everything
else.

## Archiving

Every card has an archive control (the tile's hover icon, or the button in the
reading view). The card record itself is **local to this plugin** — it never
rewrites a BB task's status — and reversible from `Archived` at the foot of the
board.

Archiving a card also archives whoever was working it:

- A request or an adopted task archives every worker thread attached to its BB
  task (via the Tasks plugin's own thread list).
- A bare question archives the thread that asked it.

Each of those goes through `bb.sdk.threads.archive`, the same cascade BB's own
UI uses — so when a thread's worktree environment has no other live thread
left in it, the host cleans it up (worktree included) on its own, within the
normal archive grace window. This plugin does not reimplement that cleanup; it
only decides which threads belong to the card being archived.

Two things it will not do, on purpose:

- **Never** archive Chief's own thread or a project chief's thread, even if one
  somehow ended up attached to a card — those are the org's standing
  leadership, never a per-task worker, checked against Chief's own roster
  before anything is touched.
- If a thread fails to archive (already gone, unreachable), the card still
  archives — you get a toast naming the ones that did not, rather than the
  whole action being blocked by one bad thread.

Archiving a **question** additionally dismisses it — the card was hiding an
agent still waiting on you, so leaving it silently would block that agent
forever; dismissing tells the asker to proceed.

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
bb command-center notify-test                                   # check the OS lets them through
bb plugin config command-center set notify off         # off | important | all
bb plugin config command-center set notifySound true
```

`important` (the default) notifies when a card reaches **In review**, **Needs
you** or **Done**. `all` adds every other lane change. Urgent questions always
play a sound.

The banner names the card, not the message inside it — a new question used to
fire an immediate notification carrying the full question text, on top of the
lane-change one that follows moments later when it lands in Needs you. Same
event, twice, and the second one was already the more readable of the two: the
card renders it properly, a notification banner just truncates it. One
notification per status change now; open the card for the rest.

Two deliberate choices. It runs in the **backend**, not the panel, because on
macOS bb keeps running with its window closed — a frontend notifier would go
quiet exactly when you are working elsewhere. And the first sweep after install
only *records* state, so adopting an existing board does not fire a banner per
card. More than four changes in one sweep collapse into a single summary.

Sent via `osascript`, so macOS attributes them to **Script Editor** — if nothing
appears, allow it under System Settings → Notifications.

## Voice

Speak instead of typing when composing a request. `⌥V` toggles the mic
anywhere in the panel, or click the mic on the composer.

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

Question cards have no mic of their own — there's nothing to dictate an
answer into. Reply in the thread's chat instead, by voice or otherwise,
however you'd normally talk to that agent.

Check the request-composing grammar without a microphone:

```
bb command-center voice-parse "bump the SDK, high priority, dispatch"
```

Voice needs transcription configured on the server
(`voiceTranscriptionEnabled`); the mics hide themselves and the panel explains
why when it is not.

## CLI

```
bb command-center ask --task "Release 2.4" --question "Ship now or wait?" \
  --asked-by "worker: release"
bb command-center review --task "ENG-42" --question "Skim the approach?" --thread thr_x
bb command-center list [--all]            # the question queue
bb command-center wait <id>               # block until the item is dismissed
bb command-center snooze <id> --hours 4

bb command-center add "<title>" [--body … --project … --priority … --urgent]
bb command-center queue [--all]           # the request lane
bb command-center ack <id> --task-key ABC-12
bb command-center close <id> --outcome "Shipped in PR #412"
```

Agents get the same surface through the bundled `user-inbox` skill.

## Chief, and working without it

Chief — one global Chief, a project chief per project, task architects
beneath them — is native to this plugin: its own nav panel, `bb command-center
chief` subcommands, agent tools (`chief_project_chief`, `chief_handoff`,
`chief_roster`), and its own tables in this plugin's database. There is no
separate plugin and no cross-plugin rpc involved.

**Chief's hierarchy is opt-in per project, not a default.** A project only
routes through Chief once you've stood up a project chief for it
(`chief_project_chief`, or `bb command-center chief project-chief`) — that's
a deliberate choice for a project with real ongoing, multi-task work. Every
other project, including one Chief has never seen, dispatches straight to a
single worker thread: one hop, one thread, no project-chief/architect
ceremony for what might be a one-line fix or a quick review. `directWorktree`
(on by default) controls whether that direct spawn gets its own worktree.

This keeps the common case lean — one agent does the task in one pass and
parks it in review — while staying as elaborate as you want: name a workflow
on the request for a multi-step protocol (e.g. implement, then a second
harness reviews), or just leave a card comment mid-flight asking the worker
for another pass (a second opinion, an extra reviewer) — the worker's brief
tells it to treat that as a normal ask, spawning a one-off delegate thread
for it rather than needing a pre-planned workflow.

## Companion plugins

This plugin needs one thing it does not bundle, and there is no plugin
manifest field to declare it as a dependency — so a fresh install of just this
plugin would otherwise leave it silently missing:

- **BB's own Tasks plugin** — task keys, comments, board status. Nearly
  everything task-related goes through it.

An `ensure-companions` background service checks for it on load and installs
it (`builtin:tasks`) if missing — no prompt, since Tasks ships with `bb`
itself.

## Data

> `~/.bb/plugins/inbox/` is **not live**. It is a pre-rename backup, left in
> place after this plugin's id changed from `inbox`. The live data is
> `~/.bb/plugins/command-center/data.db`. Delete the old directory once you are
> confident nothing is missing.

`items` (questions), `requests` (the command center lane), and Chief's own
tables (`chief`, `project_chiefs`, `architects`, `workflows`, `workflow_steps`)
all live in one SQLite at `<dataDir>/plugins/command-center/data.db`.
Migrations 0–11 reconstruct the `items` schema exactly as it shipped
originally — **append new migrations only at the end, never edit or reorder a
shipped one.**

## Layout

- `server.ts` / `app.tsx` — the command center board, queue, questions, voice,
  and Chief (the org tree, workflows, agent tools, CLI, and nav panel).
- `lib/`, `hooks/` — pure logic (voice grammar, shortcut parsing, artifact
  extraction, stall detection) and React hooks, both unit-testable without a
  server.
- `card-parts.tsx` — the notification card (open thread/link, snooze, dismiss)
  shared by the board and the reading view.
- `skills/` — `user-inbox` (notifying the Captain from an agent's own thread)
  plus `chief`, `project-chief`, and `chief-architect` (the Chief org's chain
  of command).

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

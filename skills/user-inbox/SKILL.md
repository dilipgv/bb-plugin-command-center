---
name: user-inbox
description: Ask the user for any input asynchronously instead of stalling — a decision, approval, preference, missing value, multi-select, or a request to review an agent thread. Use whenever work needs the user and they are not necessarily at the keyboard; the request lands in their BB Inbox panel and the answer comes back here. Also use to read or wait on an answer you already asked for, and to pick up work the user queued in their command center.
---

# User inbox

`bb inbox` is the user's single portal for everything agents need from them. It
is designed for many agents asking at once while the user multitasks, so:

- **Always pass `--asked-by`** with a short label for who is blocked (e.g.
  `"worker: ENG-42"`, `"chief"`). With a deep queue, an unattributed card is
  much harder to act on.
- **Use `--urgent` sparingly** — urgent items sort to the top of the queue. If
  everything is urgent, nothing is.
- Prefer it over ending a turn with "let me know what you'd like" (that loses
  the question) and over blocking prompts when the user may be away.

## Ask

Pick the shape that fits what you need:

```sh
# One choice — the best default. Options become buttons.
bb inbox ask --task "Release 2.4" --question "Ship now or wait for CI?" \
  --option "Ship now" --option "Wait for CI" --asked-by "worker: release"

# Several choices — checkboxes; the answer comes back comma-separated.
bb inbox ask --task "Sprint scope" --question "Which should land this week?" \
  --multi --option Snooze --option "Group by task" --option "Slack mirror" \
  --asked-by "chief"

# A value you cannot guess.
bb inbox ask --task "Staging deploy" --question "Which subdomain?" \
  --input --placeholder "e.g. staging-2" --asked-by "worker: deploy"

# An FYI that only needs acknowledging (no options, no --input).
bb inbox ask --task "Migration" --question "Heads up: I skipped the legacy table."
```

## Ask for a review

When the user needs to *look at something* — a subagent's thread, a diff, a PR —
send a review request. The card gets an Open-thread button, your optional verdict
buttons, and a notes box:

```sh
bb inbox review --task "MCP-1443" \
  --question "Review the cloudId fallback approach before I open the PR." \
  --thread thr_jrs8jjht6k \
  --option Approve --option "Needs changes" \
  --asked-by "worker: MCP-1443"

# Or point at anything with a URL instead:
bb inbox review --task "ENG-42" --question "Skim the PR description?" \
  --url https://github.com/acme/app/pull/42
```

On a review item `--thread` is what to review; `--ask-thread` overrides where the
answer is delivered (it defaults to your current thread). "Reviewed" with no
verdict or note comes back as `Reviewed, no comments.`

Other flags: `--task-key ABC-12` links the item to a task, `--no-notify` if you
will poll instead of being told, `--json` for parseable output.

Write requests the user can act on in five seconds: name the task, state the
decision, and make options concrete and mutually exclusive.

## Get the answer back

The loop is: you ask → the user answers in their Inbox panel → **the answer
reaches you and you continue**. Pick how it reaches you:

```sh
# Stay on the line: blocks, returns the answer, you continue in the same turn.
bb inbox ask --task "…" --question "…" --option A --option B --wait --timeout-sec 600

# Or ask and end the turn: the answer is delivered into this thread as a
# message when the user resolves it, which wakes you up to continue.
bb inbox ask --task "…" --question "…" --input

# Or check on your own schedule.
bb inbox get <id> --json
bb inbox wait <id> --timeout-sec 600 --json
```

`--wait` is right when the work cannot proceed without the answer and the user
is likely present. Ask-and-end-the-turn is right otherwise — delivery is durable
(retried until it lands, surviving restarts and busy threads), so the answer is
never lost.

If you are a **replacement thread** and an answer was delivered to a thread that
no longer exists, catch up with:

```sh
bb inbox answers --since-min 120 --json
```

Housekeeping: `bb inbox list [--all]` shows the queue; `bb inbox done <id>`
withdraws a question you no longer need answered.

The user can snooze an item, which keeps it open and unanswered but drops it out
of the queue until it comes due — so **an item you are waiting on may go quiet
for a while**. Do not re-ask; `bb inbox get <id>` still reports it, and the
answer is delivered whenever they get to it. You can snooze on their behalf when
you know something is not actionable yet:

```sh
bb inbox snooze <id> --hours 4     # also --minutes N, or --clear to wake it
```

## Retractions

The user can take an answer back after you have received it. When that happens
the next delivery starts with `CORRECTION — the answer you were given for this
("…") has been withdrawn.` Treat it as authoritative and higher-priority than the
original: stop acting on the withdrawn answer, and if you already acted, say
plainly what you did so the user can decide what to undo. A retraction may arrive
with a replacement answer or with none.

## The command center (requests the user queues for you)

The same panel has a second lane running the other way: the Captain writes
**requests** there and dispatches them to Chief. A dispatched request arrives in
Chief's thread as a message beginning:

```
COMMAND CENTER REQUEST cc_a1b2c3 · priority high · project proj_x
```

If you are **Chief**, that message is your intake. Handle it exactly like any
Captain instruction — classify it, place it with the owning project's chief, and
keep the Captain's picture accurate — with two extra obligations:

1. **Acknowledge it as soon as a task exists**, so the card stops looking
   un-started and the Captain can follow it to the board:

   ```sh
   bb inbox ack cc_a1b2c3 --task-key ABC-12
   ```

2. **Park it for sign-off** when the work is done but a human should look — a PR
   to review, a document to read, anything you should not call finished
   yourself. The card moves to the board's **In review** lane and waits there:

   ```sh
   bb inbox ready cc_a1b2c3 --outcome "PR #412 is open"
   ```

   Setting the task's own status does the same thing, so
   `bb tasks update <key> --status in_review` also lands the card in In review —
   use whichever you already have to hand.

3. **Close it** only when there is nothing to sign off: work that produced no
   reviewable artefact, or that was abandoned.

   ```sh
   bb inbox close cc_a1b2c3 --outcome "Shipped in PR #412"
   bb inbox close cc_a1b2c3 --cancelled --outcome "Superseded by ABC-19"
   ```

   **Prefer `ready` over `close` for anything reviewable.** Moving a card into
   Done is the Captain's manual step; doing it for them removes their last look
   at the work.

### The two endings, and never a third

Work must end in one of two visible states. The Captain watches the board and is
notified on both; anything else is silence, and silence means they never look at
the card again.

**Done → In review.** The moment the work is finished, park it:

```sh
bb inbox ready cc_a1b2c3 --outcome "PR #412 is open"
```

**Stuck → Needs you.** The moment you cannot proceed — a decision, a missing
credential, an approval, an ambiguity — file it as a question:

```sh
bb inbox ask --task "<key>" --question "…" --option "…" --option "…" \
  --asked-by "worker: <key>"
```

**A blocker buried in a comment is not a question.** A comment notifies the
Captain that you replied, but it leaves the card sitting in a lane that claims
someone is working on it. If you need something, ask; if you are done, park it.

A card left in progress with nothing said for a few hours is flagged **stalled**
and moved into Needs you by the plugin itself, so going quiet does not hide work
— it just makes the report worse than if you had asked.

Never silently drop a request: if it is not actionable, ask about it through
`bb inbox ask` rather than leaving the card sitting in flight.

Reading and adding requests (any agent may do this — useful for capturing
follow-ups the Captain should decide on later):

```sh
bb inbox queue --json                 # the request lane, in order
bb inbox add "Bump the MCP SDK" --body "Blocked on the 2.1 release" --priority low
```

`bb inbox add` only **queues** — dispatch is the Captain's click. Do not
dispatch on their behalf.

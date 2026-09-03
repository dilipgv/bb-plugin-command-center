---
name: user-inbox
description: Notify the user that something needs them — a review, a blocking decision, or an FYI — instead of stalling or burying it in a comment. Use whenever work needs the user and they are not necessarily at the keyboard; it lands as a lightweight card in their BB Inbox and a badge on the board. There is no form to fill out on their end — they reply in the thread's own chat, the same way they would to any agent. Also use to pick up work the user queued in their command center.
---

# User inbox

`bb command-center` is the user's single portal for everything agents need from them. It
is deliberately lean: an item is a **notification**, not a form. The user never
picks from options or types into a special box — they read your question and
reply directly in this thread's chat, exactly like any other conversation.

- **Always pass `--asked-by`** with a short label for who is blocked (e.g.
  `"worker: ENG-42"`, `"chief"`). With a deep queue, an unattributed card is
  much harder to act on.
- **Use `--urgent` sparingly** — urgent items sort to the top of the queue. If
  everything is urgent, nothing is.
- Prefer it over ending a turn with "let me know what you'd like" (that loses
  the question) and over blocking prompts when the user may be away.

## Ask

State the question plainly — there is nothing to configure:

```sh
bb command-center ask --task "Release 2.4" --question "Ship now, or wait for CI?" \
  --asked-by "worker: release"

# An FYI that needs no reply at all still gets a card, so it isn't missed:
bb command-center ask --task "Migration" --question "Heads up: I skipped the legacy table."
```

The user's actual answer is whatever they say back in this thread — read the
conversation, not a structured field. Once you've seen it and acted, the item
gets dismissed (by you or the user); there is no "answer" to submit for it.

## Ask for a review

When the user needs to *look at something* — a subagent's thread, a diff, a PR —
send a review request. The card gets an Open-thread (or Open-link) button; there
is no verdict button to wait on — the user reviews and tells you what they think
in chat, same as an ask:

```sh
bb command-center review --task "MCP-1443" \
  --question "Review the cloudId fallback approach before I open the PR." \
  --thread thr_jrs8jjht6k \
  --asked-by "worker: MCP-1443"

# Or point at anything with a URL instead:
bb command-center review --task "ENG-42" --question "Skim the PR description?" \
  --url https://github.com/acme/app/pull/42
```

On a review item `--thread` is what to review; `--ask-thread` overrides where the
notification points (it defaults to your current thread).

Other flags: `--task-key ABC-12` links the item to a task, `--no-notify` if you
will poll instead of being told, `--json` for parseable output.

Write requests the user can act on in five seconds: name the task and state the
question — there's no options list to design.

## Waiting on a reply

The loop is: you ask → the user reads the card, opens the thread if they need
to, and replies **as a normal message in this thread** → you see it and
continue. Pick how you wait for that:

```sh
# Stay on the line: blocks until the item is dismissed (i.e. handled), then
# you keep going — but the actual content of the reply is in this thread's
# own message history, not in the CLI output.
bb command-center ask --task "…" --question "…" --wait --timeout-sec 600

# Or ask and end the turn: a reply landing in this thread as a message is
# what wakes you up to continue — check the item's own status if you want to
# confirm it's been seen.
bb command-center get <id> --json
bb command-center wait <id> --timeout-sec 600 --json
```

`--wait` is right when the work cannot proceed without a reply and the user is
likely present. Ask-and-end-the-turn is right otherwise.

Housekeeping: `bb command-center list [--all]` shows the queue; `bb command-center done <id>`
withdraws a question you no longer need answered.

The user can snooze an item, which keeps it open but drops it out of the queue
until it comes due — so **an item you are waiting on may go quiet for a
while**. Do not re-ask; `bb command-center get <id>` still reports it. You can
snooze on their behalf when you know something is not actionable yet:

```sh
bb command-center snooze <id> --hours 4     # also --minutes N, or --clear to wake it
```

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
   bb command-center ack cc_a1b2c3 --task-key ABC-12
   ```

2. **Park it for sign-off** when the work is done but a human should look — a PR
   to review, a document to read, anything you should not call finished
   yourself. The card moves to the board's **In review** lane and waits there:

   ```sh
   bb command-center ready cc_a1b2c3 --outcome "PR #412 is open"
   ```

   Setting the task's own status does the same thing, so
   `bb tasks update <key> --status in_review` also lands the card in In review —
   use whichever you already have to hand.

3. **Close it** only when there is nothing to sign off: work that produced no
   reviewable artefact, or that was abandoned.

   ```sh
   bb command-center close cc_a1b2c3 --outcome "Shipped in PR #412"
   bb command-center close cc_a1b2c3 --cancelled --outcome "Superseded by ABC-19"
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
bb command-center ready cc_a1b2c3 --outcome "PR #412 is open"
```

**Stuck → Needs you.** The moment you cannot proceed — a decision, a missing
credential, an approval, an ambiguity — file it as a question:

```sh
bb command-center ask --task "<key>" --question "…" --asked-by "worker: <key>"
```

**A blocker buried in a comment is not a question.** A comment notifies the
Captain that you replied, but it leaves the card sitting in a lane that claims
someone is working on it. If you need something, ask; if you are done, park it.

A card left in progress with nothing said for a few hours is flagged **stalled**
and moved into Needs you by the plugin itself, so going quiet does not hide work
— it just makes the report worse than if you had asked.

Never silently drop a request: if it is not actionable, ask about it through
`bb command-center ask` rather than leaving the card sitting in flight.

Reading and adding requests (any agent may do this — useful for capturing
follow-ups the Captain should decide on later):

```sh
bb command-center queue --json                 # the request lane, in order
bb command-center add "Bump the MCP SDK" --body "Blocked on the 2.1 release" --priority low
```

`bb command-center add` only **queues** — dispatch is the Captain's click. Do not
dispatch on their behalf.

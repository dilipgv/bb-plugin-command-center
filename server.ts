/**
 * Inbox — the Captain's command center.
 *
 * Two lanes, opposite directions, one panel:
 *
 *   items    agent → you. A question, review request or FYI. The answer is
 *            delivered back into the asking thread durably.
 *   requests you → the org. Work you queue and then dispatch to Chief, which
 *            demuxes it to the owning project chief and its architects.
 *
 * The `items` schema predates this rebuild; the first twelve migrations
 * reconstruct it exactly so an existing data.db is adopted untouched. Append
 * new migrations only at the end.
 */
import {
  defineRpcContract,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
  type JsonValue,
} from "@bb/plugin-sdk";
import { z } from "zod";

import {
  matchSpokenOption,
  matchSpokenOptions,
  parseVoiceCommand,
  type VoiceProject,
} from "./lib/voice-command";

// ---------------------------------------------------------------- shapes

const ITEM_KINDS = ["options", "multi", "text", "ack", "review"] as const;
const PRIORITIES = ["low", "normal", "high"] as const;
const REQUEST_STATES = [
  "queued",
  "dispatched",
  "in_flight",
  "done",
  "cancelled",
] as const;

/**
 * The item DTO is a published contract: chief-nav reads `list().open` to draw
 * its "waiting on the Captain" rail, so fields may be added but never renamed.
 */
const itemDto = z.object({
  id: z.string(),
  createdAt: z.number(),
  task: z.string(),
  question: z.string(),
  kind: z.enum(ITEM_KINDS),
  options: z.array(z.string()),
  placeholder: z.string().nullable(),
  taskKey: z.string().nullable(),
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  status: z.enum(["open", "answered", "dismissed"]),
  answer: z.string().nullable(),
  priorAnswer: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  urgent: z.boolean(),
  snoozedUntil: z.number().nullable(),
  askedBy: z.string().nullable(),
  reviewThreadId: z.string().nullable(),
  reviewUrl: z.string().nullable(),
});

const requestDto = z.object({
  id: z.string(),
  createdAt: z.number(),
  title: z.string(),
  body: z.string(),
  projectId: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  urgent: z.boolean(),
  state: z.enum(REQUEST_STATES),
  queuePos: z.number(),
  chiefThreadId: z.string().nullable(),
  taskKey: z.string().nullable(),
  dispatchedAt: z.number().nullable(),
  closedAt: z.number().nullable(),
  outcome: z.string().nullable(),
  /** Id of an open question blocking this request, when one exists. */
  blockedBy: z.string().nullable(),
});

export type InboxItem = z.infer<typeof itemDto>;
export type InboxRequest = z.infer<typeof requestDto>;

/**
 * An audio clip from the panel. Base64 because rpc carries strict JSON only;
 * the filename travels all the way to the transcription backend, which infers
 * the audio format from its extension.
 */
const voiceClipInput = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
  filename: z.string().min(1),
});

/** ~6 MB of audio — far more than a spoken command, far under the 25 MB cap. */
const MAX_AUDIO_BASE64_LENGTH = 8_000_000;

// ------------------------------------------------------------------- board

const LANES = ["queue", "in_progress", "needs_you", "done"] as const;
export type BoardLane = (typeof LANES)[number];

/** Lane → BB task status, for writing a drag back to the task board. */
const LANE_TASK_STATUS: Record<
  Exclude<BoardLane, "needs_you">,
  "todo" | "in_progress" | "done"
> = {
  queue: "todo",
  in_progress: "in_progress",
  done: "done",
};

const FINISHED_TASK_STATUSES = new Set(["done", "canceled"]);

/**
 * One card on the board, whatever it actually is underneath: a request you
 * queued, a task the org created without you, or a bare question from an agent.
 * The panel draws these and nothing else.
 */
const boardCardDto = z.object({
  id: z.string(),
  kind: z.enum(["request", "task", "question"]),
  lane: z.enum(LANES),
  title: z.string(),
  body: z.string(),
  priority: z.enum(PRIORITIES),
  urgent: z.boolean(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  taskId: z.string().nullable(),
  taskKey: z.string().nullable(),
  taskStatus: z.string().nullable(),
  chiefThreadId: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: z.number(),
  commentCount: z.number(),
  /** Threads working this card, newest first. */
  workers: z.array(
    z.object({
      threadId: z.string(),
      title: z.string().nullable(),
      liveStatus: z.string().nullable(),
    }),
  ),
  /** The open question holding this card in Needs you, when there is one. */
  question: itemDto.nullable(),
  /** False for cards this panel may not move (bare questions). */
  movable: z.boolean(),
  /** True when moving out of Queue would dispatch work to Chief. */
  dispatchOnAdvance: z.boolean(),
});

export type BoardCard = z.infer<typeof boardCardDto>;

const boardCommentDto = z.object({
  id: z.string(),
  body: z.string(),
  authorName: z.string(),
  kind: z.enum(["user", "agent", "system"]),
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  createdAt: z.string(),
  notifiedCount: z.number(),
  /** True for a comment still queued locally because no task exists yet. */
  pending: z.boolean(),
});

export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({
      open: z.array(itemDto),
      snoozed: z.array(itemDto),
      resolved: z.array(itemDto),
    }),
  },
  answer: {
    input: z.object({ id: z.string(), answer: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  dismiss: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  retract: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  snooze: {
    input: z.object({ id: z.string(), untilMs: z.number().nullable() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  queue: {
    input: z.null(),
    output: z.object({
      requests: z.array(requestDto),
      chiefThreadId: z.string().nullable(),
      chiefStatus: z.string().nullable(),
      chiefError: z.string().nullable(),
    }),
  },
  addRequest: {
    input: z
      .object({
        title: z.string().min(1),
        body: z.string().optional(),
        projectId: z.string().nullish(),
        priority: z.enum(PRIORITIES).optional(),
        urgent: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ id: z.string() }),
  },
  updateRequest: {
    input: z
      .object({
        id: z.string(),
        title: z.string().min(1).optional(),
        body: z.string().optional(),
        projectId: z.string().nullish(),
        priority: z.enum(PRIORITIES).optional(),
        urgent: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  moveRequest: {
    input: z
      .object({
        id: z.string(),
        direction: z.enum(["up", "down", "top", "bottom"]),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  dispatchRequest: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({
      ok: z.boolean(),
      threadId: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
  closeRequest: {
    input: z
      .object({
        id: z.string(),
        outcome: z.string().nullish(),
        cancelled: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  reopenRequest: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  projects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  board: {
    input: z.null(),
    output: z.object({
      cards: z.array(boardCardDto),
      chiefThreadId: z.string().nullable(),
      chiefError: z.string().nullable(),
      /** Non-null when the Tasks plugin could not be read. */
      tasksError: z.string().nullable(),
    }),
  },
  moveCard: {
    input: z
      .object({ cardId: z.string(), lane: z.enum(LANES) })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      /** Set when the move dispatched work to Chief. */
      dispatchedTo: z.string().nullable(),
    }),
  },
  cardComments: {
    input: z.object({ cardId: z.string() }).strict(),
    output: z.object({
      comments: z.array(boardCommentDto),
      /** False when comments cannot reach a worker yet (no task). */
      canNotify: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  addCardComment: {
    input: z
      .object({ cardId: z.string(), body: z.string().min(1) })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      /** How many working threads were handed the comment. */
      notified: z.number(),
      pending: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  voiceStatus: {
    input: z.null(),
    output: z.object({
      enabled: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  /** Dictation: audio in, text out. */
  transcribe: {
    input: voiceClipInput.extend({ prompt: z.string().optional() }).strict(),
    output: z.object({ text: z.string() }),
  },
  /** A spoken command parsed into a request draft. Never dispatches by itself. */
  voiceCompose: {
    input: voiceClipInput.strict(),
    output: z.object({
      transcript: z.string(),
      title: z.string(),
      body: z.string(),
      priority: z.enum(PRIORITIES),
      urgent: z.boolean(),
      projectId: z.string().nullable(),
      projectName: z.string().nullable(),
      intent: z.enum(["queue", "dispatch"]),
      understood: z.array(z.string()),
    }),
  },
  /** A spoken answer to one open question, matched against its options. */
  voiceAnswer: {
    input: voiceClipInput.extend({ itemId: z.string() }).strict(),
    output: z.object({
      transcript: z.string(),
      /** Best single option, when one clearly wins. */
      option: z.string().nullable(),
      confidence: z.number(),
      /** Every option mentioned, for multi-select questions. */
      options: z.array(z.string()),
    }),
  },
  /** Test phrasing without a microphone. Also powers `bb inbox voice-parse`. */
  parseVoice: {
    input: z.object({ transcript: z.string() }).strict(),
    output: z.object({
      transcript: z.string(),
      title: z.string(),
      body: z.string(),
      priority: z.enum(PRIORITIES),
      urgent: z.boolean(),
      projectId: z.string().nullable(),
      projectName: z.string().nullable(),
      intent: z.enum(["queue", "dispatch"]),
      understood: z.array(z.string()),
    }),
  },
});

// ------------------------------------------------------------------ rows

interface ItemRow {
  id: string;
  created_at: number;
  task: string;
  question: string;
  kind: string;
  options: string;
  placeholder: string | null;
  task_key: string | null;
  thread_id: string | null;
  project_id: string | null;
  status: string;
  answer: string | null;
  resolved_at: number | null;
  notify: number;
  delivered_at: number | null;
  delivery_attempts: number;
  delivery_error: string | null;
  asked_by: string | null;
  review_thread_id: string | null;
  review_url: string | null;
  urgent: number;
  snoozed_until: number | null;
  prior_answer: string | null;
  correction_delivered_at: number | null;
}

interface RequestRow {
  id: string;
  created_at: number;
  title: string;
  body: string;
  project_id: string | null;
  priority: string;
  urgent: number;
  state: string;
  queue_pos: number;
  chief_thread_id: string | null;
  task_key: string | null;
  dispatched_at: number | null;
  closed_at: number | null;
  outcome: string | null;
}

const MAX_DELIVERY_ATTEMPTS = 20;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function parseOptions(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function coerceKind(raw: string): (typeof ITEM_KINDS)[number] {
  return (ITEM_KINDS as readonly string[]).includes(raw)
    ? (raw as (typeof ITEM_KINDS)[number])
    : "ack";
}

function coercePriority(raw: string | undefined): (typeof PRIORITIES)[number] {
  return raw !== undefined && (PRIORITIES as readonly string[]).includes(raw)
    ? (raw as (typeof PRIORITIES)[number])
    : "normal";
}

function toItem(row: ItemRow): InboxItem {
  const status =
    row.status === "answered" || row.status === "dismissed"
      ? row.status
      : "open";
  return {
    id: row.id,
    createdAt: row.created_at,
    task: row.task,
    question: row.question,
    kind: coerceKind(row.kind),
    options: parseOptions(row.options),
    placeholder: row.placeholder,
    taskKey: row.task_key,
    threadId: row.thread_id,
    projectId: row.project_id,
    status,
    answer: row.answer,
    priorAnswer: row.prior_answer,
    resolvedAt: row.resolved_at,
    urgent: row.urgent === 1,
    snoozedUntil: row.snoozed_until,
    askedBy: row.asked_by,
    reviewThreadId: row.review_thread_id,
    reviewUrl: row.review_url,
  };
}

function toRequest(row: RequestRow, blockedBy: string | null): InboxRequest {
  const state = (REQUEST_STATES as readonly string[]).includes(row.state)
    ? (row.state as InboxRequest["state"])
    : "queued";
  return {
    id: row.id,
    createdAt: row.created_at,
    title: row.title,
    body: row.body,
    projectId: row.project_id,
    priority: coercePriority(row.priority),
    urgent: row.urgent === 1,
    state,
    queuePos: row.queue_pos,
    chiefThreadId: row.chief_thread_id,
    taskKey: row.task_key,
    dispatchedAt: row.dispatched_at,
    closedAt: row.closed_at,
    outcome: row.outcome,
    blockedBy,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// --------------------------------------------------------------- plugin

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    chiefThreadId: {
      type: "string",
      label: "Chief thread id",
      default: "",
    },
    defaultProject: { type: "project", label: "Default project for requests" },
    // BB's keyboard settings only accept its own built-in commands, so the
    // panel owns these and reads them from here.
    voiceShortcut: {
      type: "string",
      label: "Shortcut: start/stop voice capture",
      default: "alt+v",
    },
    detailShortcut: {
      type: "string",
      label: "Shortcut: add detail to a request",
      default: "alt+d",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    // 0–11 reconstruct the schema this plugin shipped before its source was
    // lost. They are already recorded as applied on the live database, so they
    // only ever execute on a fresh install.
    `CREATE TABLE IF NOT EXISTS items (
       id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL,
       task TEXT NOT NULL,
       question TEXT NOT NULL,
       kind TEXT NOT NULL,
       options TEXT NOT NULL DEFAULT '[]',
       placeholder TEXT,
       task_key TEXT,
       thread_id TEXT,
       project_id TEXT,
       status TEXT NOT NULL DEFAULT 'open',
       answer TEXT,
       resolved_at INTEGER,
       notify INTEGER NOT NULL DEFAULT 1
     )`,
    `CREATE INDEX IF NOT EXISTS items_status_created ON items (status, created_at DESC)`,
    `ALTER TABLE items ADD COLUMN delivered_at INTEGER`,
    `ALTER TABLE items ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE items ADD COLUMN delivery_error TEXT`,
    `ALTER TABLE items ADD COLUMN asked_by TEXT`,
    `ALTER TABLE items ADD COLUMN review_thread_id TEXT`,
    `ALTER TABLE items ADD COLUMN review_url TEXT`,
    `ALTER TABLE items ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS items_urgent_created ON items (urgent, created_at DESC)`,
    `ALTER TABLE items ADD COLUMN snoozed_until INTEGER`,
    `ALTER TABLE items ADD COLUMN prior_answer TEXT`,
    // 12+ are new. Append only.
    `ALTER TABLE items ADD COLUMN correction_delivered_at INTEGER`,
    `CREATE TABLE IF NOT EXISTS requests (
       id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL,
       title TEXT NOT NULL,
       body TEXT NOT NULL DEFAULT '',
       project_id TEXT,
       priority TEXT NOT NULL DEFAULT 'normal',
       urgent INTEGER NOT NULL DEFAULT 0,
       state TEXT NOT NULL DEFAULT 'queued',
       queue_pos REAL NOT NULL,
       chief_thread_id TEXT,
       task_key TEXT,
       dispatched_at INTEGER,
       closed_at INTEGER,
       outcome TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS requests_state_pos ON requests (state, queue_pos)`,
    // Comments written before a task exists. Flushed into the task board (and
    // delivered to whoever is working it) the moment Chief acks a task key.
    `CREATE TABLE IF NOT EXISTS request_comments (
       id TEXT PRIMARY KEY,
       request_id TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       body TEXT NOT NULL,
       delivered_task_id TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS request_comments_request ON request_comments (request_id, created_at)`,
  ]);

  function publish(): void {
    bb.realtime.publish("changed", { at: Date.now() });
  }

  // ------------------------------------------------------------ item reads

  function getItem(id: string): ItemRow | undefined {
    return db
      .prepare<[string], ItemRow>(`SELECT * FROM items WHERE id = ?`)
      .get(id);
  }

  function listItems(): {
    open: InboxItem[];
    snoozed: InboxItem[];
    resolved: InboxItem[];
  } {
    const now = Date.now();
    const rows = db
      .prepare<[], ItemRow>(`SELECT * FROM items ORDER BY created_at DESC`)
      .all();
    const open: InboxItem[] = [];
    const snoozed: InboxItem[] = [];
    const resolved: InboxItem[] = [];
    for (const row of rows) {
      const item = toItem(row);
      if (item.status !== "open") {
        resolved.push(item);
      } else if (item.snoozedUntil !== null && item.snoozedUntil > now) {
        snoozed.push(item);
      } else {
        open.push(item);
      }
    }
    // Urgent first, then oldest first: the queue is worked top-down.
    open.sort((a, b) =>
      a.urgent === b.urgent ? a.createdAt - b.createdAt : a.urgent ? -1 : 1,
    );
    snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
    return { open, snoozed, resolved: resolved.slice(0, 100) };
  }

  // -------------------------------------------------------- item mutations

  function insertItem(input: {
    task: string;
    question: string;
    kind: (typeof ITEM_KINDS)[number];
    options: string[];
    placeholder: string | null;
    taskKey: string | null;
    threadId: string | null;
    projectId: string | null;
    askedBy: string | null;
    reviewThreadId: string | null;
    reviewUrl: string | null;
    urgent: boolean;
    notify: boolean;
  }): string {
    const id = newId("inbx");
    db.prepare(
      `INSERT INTO items (
         id, created_at, task, question, kind, options, placeholder, task_key,
         thread_id, project_id, status, notify, asked_by, review_thread_id,
         review_url, urgent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      Date.now(),
      input.task,
      input.question,
      input.kind,
      JSON.stringify(input.options),
      input.placeholder,
      input.taskKey,
      input.threadId,
      input.projectId,
      input.notify ? 1 : 0,
      input.askedBy,
      input.reviewThreadId,
      input.reviewUrl,
      input.urgent ? 1 : 0,
    );
    publish();
    return id;
  }

  function resolveItem(
    id: string,
    status: "answered" | "dismissed",
    answer: string | null,
  ): boolean {
    if (!getItem(id)) return false;
    db.prepare(
      `UPDATE items
         SET status = ?, answer = ?, resolved_at = ?, snoozed_until = NULL,
             delivered_at = NULL, delivery_error = NULL
       WHERE id = ?`,
    ).run(status, answer, Date.now(), id);
    publish();
    void deliverPending();
    return true;
  }

  /** The user takes an answer back. Re-arms a CORRECTION delivery. */
  function retractItem(id: string): boolean {
    const row = getItem(id);
    if (!row) return false;
    const prior = row.answer ?? row.prior_answer;
    db.prepare(
      `UPDATE items
         SET status = 'open', answer = NULL, prior_answer = ?, resolved_at = NULL,
             delivered_at = NULL, correction_delivered_at = NULL,
             delivery_attempts = 0, delivery_error = NULL
       WHERE id = ?`,
    ).run(prior, id);
    publish();
    void deliverPending();
    return true;
  }

  // ------------------------------------------------------------- delivery

  function describeItem(row: ItemRow): string {
    const label = row.task.trim() ? `"${row.task}"` : "an Inbox item";
    return `${label} — ${row.question}`;
  }

  /**
   * The one message this item owes its asker, if any. Corrections are tracked
   * separately from the answer so a withdrawal is never lost behind an answer
   * that was already delivered.
   */
  function pendingDelivery(
    row: ItemRow,
  ): { text: string; markCorrection: boolean; markAnswer: boolean } | null {
    if (row.notify !== 1 || row.thread_id === null) return null;

    if (row.prior_answer !== null && row.correction_delivered_at === null) {
      const replaced =
        row.status === "answered" && row.answer !== null
          ? `The replacement answer is:\n\n${row.answer}`
          : "No replacement answer has been given yet. Stop acting on the withdrawn answer; if you already acted on it, say plainly what you did so the user can decide what to undo.";
      return {
        text: [
          `CORRECTION — the answer you were given for this ("${row.prior_answer}") has been withdrawn.`,
          "",
          `This was about ${describeItem(row)}`,
          "",
          replaced,
        ].join("\n"),
        markCorrection: true,
        markAnswer: row.status === "answered" && row.answer !== null,
      };
    }

    if (row.delivered_at !== null) return null;

    if (row.status === "answered") {
      return {
        text: `Inbox answer for ${describeItem(row)}\n\n${row.answer ?? ""}`,
        markCorrection: false,
        markAnswer: true,
      };
    }
    if (row.status === "dismissed") {
      return {
        text: `Inbox: you asked about ${describeItem(row)}\n\nThe user dismissed this without answering. Proceed with your best judgement, or ask again more concretely if you genuinely cannot.`,
        markCorrection: false,
        markAnswer: true,
      };
    }
    return null;
  }

  let delivering = false;

  async function deliverPending(): Promise<void> {
    if (delivering) return;
    delivering = true;
    try {
      const rows = db
        .prepare<[number], ItemRow>(
          `SELECT * FROM items
             WHERE notify = 1 AND thread_id IS NOT NULL
               AND delivery_attempts < ?
               AND (
                 (prior_answer IS NOT NULL AND correction_delivered_at IS NULL)
                 OR (status IN ('answered','dismissed') AND delivered_at IS NULL)
               )
             ORDER BY COALESCE(resolved_at, created_at) ASC
             LIMIT 25`,
        )
        .all(MAX_DELIVERY_ATTEMPTS);

      for (const row of rows) {
        const pending = pendingDelivery(row);
        if (pending === null || row.thread_id === null) continue;
        try {
          await bb.sdk.threads.send({
            threadId: row.thread_id,
            mode: "auto",
            input: [{ type: "text", text: pending.text, mentions: [] }],
          });
          const now = Date.now();
          db.prepare(
            `UPDATE items
               SET delivered_at = CASE WHEN ? = 1 THEN ? ELSE delivered_at END,
                   correction_delivered_at = CASE WHEN ? = 1 THEN ? ELSE correction_delivered_at END,
                   delivery_error = NULL
             WHERE id = ?`,
          ).run(
            pending.markAnswer ? 1 : 0,
            now,
            pending.markCorrection ? 1 : 0,
            now,
            row.id,
          );
          bb.log.info(`delivered ${row.id} to ${row.thread_id}`);
        } catch (error) {
          db.prepare(
            `UPDATE items
               SET delivery_attempts = delivery_attempts + 1, delivery_error = ?
             WHERE id = ?`,
          ).run(String(error), row.id);
          bb.log.warn(`delivery failed for ${row.id}: ${String(error)}`);
        }
      }
    } finally {
      delivering = false;
    }
  }

  bb.background.service("deliver-answers", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await deliverPending();
        } catch (error) {
          bb.log.error(`delivery sweep failed: ${String(error)}`);
        }
        await sleep(3_000, signal);
      }
    },
  });

  // ------------------------------------------------------------- requests

  function requestRow(id: string): RequestRow | undefined {
    return db
      .prepare<[string], RequestRow>(`SELECT * FROM requests WHERE id = ?`)
      .get(id);
  }

  /** An open question tagged with the same task key blocks its request. */
  function blockersByTaskKey(): Map<string, string> {
    const now = Date.now();
    const rows = db
      .prepare<
        [],
        { id: string; task_key: string | null; snoozed_until: number | null }
      >(
        `SELECT id, task_key, snoozed_until FROM items
           WHERE status = 'open' AND task_key IS NOT NULL`,
      )
      .all();
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.task_key === null) continue;
      if (row.snoozed_until !== null && row.snoozed_until > now) continue;
      if (!map.has(row.task_key)) map.set(row.task_key, row.id);
    }
    return map;
  }

  function listRequests(): InboxRequest[] {
    const blockers = blockersByTaskKey();
    return db
      .prepare<[], RequestRow>(
        `SELECT * FROM requests
           ORDER BY
             CASE state WHEN 'queued' THEN 0 WHEN 'dispatched' THEN 1
                        WHEN 'in_flight' THEN 1 ELSE 2 END,
             urgent DESC, queue_pos ASC, created_at ASC`,
      )
      .all()
      .map((row) =>
        toRequest(
          row,
          row.task_key !== null ? (blockers.get(row.task_key) ?? null) : null,
        ),
      );
  }

  function nextQueuePos(): number {
    const row = db
      .prepare<[], { pos: number | null }>(
        `SELECT MAX(queue_pos) AS pos FROM requests`,
      )
      .get();
    return (row?.pos ?? 0) + 1;
  }

  function addRequest(input: {
    title: string;
    body?: string;
    projectId?: string | null;
    priority?: (typeof PRIORITIES)[number];
    urgent?: boolean;
  }): string {
    const id = newId("cc");
    db.prepare(
      `INSERT INTO requests (
         id, created_at, title, body, project_id, priority, urgent, state, queue_pos
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      id,
      Date.now(),
      input.title,
      input.body ?? "",
      input.projectId ?? null,
      coercePriority(input.priority),
      input.urgent === true ? 1 : 0,
      nextQueuePos(),
    );
    publish();
    return id;
  }

  function moveRequest(
    id: string,
    direction: "up" | "down" | "top" | "bottom",
  ): boolean {
    const queued = db
      .prepare<[], RequestRow>(
        `SELECT * FROM requests WHERE state = 'queued'
           ORDER BY urgent DESC, queue_pos ASC, created_at ASC`,
      )
      .all();
    const index = queued.findIndex((row) => row.id === id);
    if (index < 0) return false;

    let target: number;
    if (direction === "top") target = 0;
    else if (direction === "bottom") target = queued.length - 1;
    else target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= queued.length || target === index) return false;

    const reordered = [...queued];
    const [moved] = reordered.splice(index, 1);
    if (moved === undefined) return false;
    reordered.splice(target, 0, moved);
    const update = db.prepare(`UPDATE requests SET queue_pos = ? WHERE id = ?`);
    db.transaction(() => {
      reordered.forEach((row, position) => update.run(position + 1, row.id));
    })();
    publish();
    return true;
  }

  /**
   * Where Chief lives. chief-nav owns that fact, so ask it first and fall back
   * to the setting — this plugin stays useful without chief-nav installed,
   * exactly as chief-nav stays useful without this one.
   */
  async function chiefThread(): Promise<{
    threadId: string | null;
    status: string | null;
    error: string | null;
  }> {
    try {
      const state = await bb.sdk.plugins.callRpc({
        pluginId: "chief-nav",
        method: "state",
        input: null,
        outputSchema: z.looseObject({
          chief: z
            .looseObject({
              threadId: z.string(),
              status: z.string().nullish(),
            })
            .nullable(),
        }),
      });
      if (state.chief?.threadId !== undefined) {
        return {
          threadId: state.chief.threadId,
          status: state.chief.status ?? null,
          error: null,
        };
      }
    } catch (error) {
      bb.log.debug(`chief-nav unavailable: ${String(error)}`);
    }
    const configured = (await settings.get()).chiefThreadId.trim();
    if (configured !== "") {
      return { threadId: configured, status: null, error: null };
    }
    return {
      threadId: null,
      status: null,
      error:
        "No Chief thread found. Start Chief in the Chief panel, or set the Chief thread id in this plugin's settings.",
    };
  }

  function dispatchBrief(row: RequestRow, projectName: string | null): string {
    const scope = [
      `priority ${coercePriority(row.priority)}`,
      row.urgent === 1 ? "URGENT" : null,
      projectName ?? row.project_id,
    ]
      .filter((part): part is string => part !== null && part !== undefined)
      .join(" · ");
    return [
      `COMMAND CENTER REQUEST ${row.id} · ${scope}`,
      "",
      row.title,
      ...(row.body.trim() !== "" ? ["", row.body.trim()] : []),
      "",
      "Route this: decide which project owns it, make sure that project has a chief, and send it down. Do not do the work yourself.",
      `Ack it as soon as a task exists: \`bb inbox ack ${row.id} --task-key <key>\`.`,
      `Close it when it lands or is abandoned: \`bb inbox close ${row.id} --outcome "…"\`.`,
    ].join("\n");
  }

  async function dispatchRequest(
    id: string,
  ): Promise<{ ok: boolean; threadId: string | null; error: string | null }> {
    const row = requestRow(id);
    if (row === undefined) {
      return { ok: false, threadId: null, error: `No request ${id}.` };
    }
    if (row.state !== "queued") {
      return {
        ok: false,
        threadId: row.chief_thread_id,
        error: `Request ${id} is already ${row.state}.`,
      };
    }
    const chief = await chiefThread();
    if (chief.threadId === null) {
      return { ok: false, threadId: null, error: chief.error };
    }

    let projectName: string | null = null;
    if (row.project_id !== null) {
      try {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        projectName =
          projects.find((project) => project.id === row.project_id)?.name ??
          null;
      } catch {
        projectName = null;
      }
    }

    try {
      await bb.sdk.threads.send({
        threadId: chief.threadId,
        mode: "auto",
        input: [
          { type: "text", text: dispatchBrief(row, projectName), mentions: [] },
        ],
      });
    } catch (error) {
      return { ok: false, threadId: chief.threadId, error: String(error) };
    }

    db.prepare(
      `UPDATE requests
         SET state = 'dispatched', chief_thread_id = ?, dispatched_at = ?
       WHERE id = ?`,
    ).run(chief.threadId, Date.now(), id);
    publish();
    bb.log.info(`dispatched ${id} to Chief ${chief.threadId}`);
    return { ok: true, threadId: chief.threadId, error: null };
  }

  async function ackRequest(id: string, taskKey: string): Promise<boolean> {
    if (requestRow(id) === undefined) return false;
    db.prepare(
      `UPDATE requests SET state = 'in_flight', task_key = ? WHERE id = ?`,
    ).run(taskKey, id);
    publish();
    // Context you added while it was still queued now has somewhere to land.
    const task = await resolveTaskByKey(taskKey);
    if (task !== null) await flushPendingComments(id, task.id);
    return true;
  }

  function closeRequest(
    id: string,
    outcome: string | null,
    cancelled: boolean,
  ): boolean {
    if (requestRow(id) === undefined) return false;
    db.prepare(
      `UPDATE requests SET state = ?, outcome = ?, closed_at = ? WHERE id = ?`,
    ).run(cancelled ? "cancelled" : "done", outcome, Date.now(), id);
    publish();
    return true;
  }

  // ---------------------------------------------------------------- board

  /**
   * The Tasks plugin is the durable substrate: it owns task keys (which Chief's
   * handoff contract requires), delivers comments to whoever is working a task,
   * and survives the threads that come and go. This panel is the only surface
   * the Captain should have to look at, so everything it holds is mirrored onto
   * a card here. Every call tolerates Tasks being absent.
   */
  const taskRowSchema = z.looseObject({
    id: z.string(),
    key: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    status: z.string(),
    priority: z.string().nullish(),
    projectId: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
  });
  type TaskRow = z.infer<typeof taskRowSchema>;

  const MAX_TASK_PAGES = 20;
  const MAX_ENRICHED_CARDS = 40;
  /** Finished work stops being interesting quickly; keep Done readable. */
  const DONE_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;

  async function tasksCall<TOutput>(
    method: string,
    input: JsonValue,
    outputSchema: z.ZodType<TOutput>,
  ): Promise<TOutput> {
    return await bb.sdk.plugins.callRpc({
      pluginId: "tasks",
      method,
      input,
      outputSchema,
    });
  }

  const taskPageSchema = z.object({
    tasks: z.array(taskRowSchema),
    nextCursor: z.string().nullable(),
  });
  type TaskPage = z.infer<typeof taskPageSchema>;

  async function listAllTasks(): Promise<TaskRow[]> {
    const rows: TaskRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
      const result: TaskPage = await tasksCall(
        "listTasks",
        cursor === null ? {} : { cursor },
        taskPageSchema,
      );
      rows.push(...result.tasks);
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    return rows;
  }

  async function taskWorkers(
    taskId: string,
  ): Promise<{ threadId: string; title: string | null; liveStatus: string | null }[]> {
    try {
      const result = await tasksCall(
        "listTaskThreads",
        { taskId },
        z.object({
          taskThreads: z.array(
            z.looseObject({
              threadId: z.string(),
              title: z.string().nullish(),
              liveStatus: z.string().nullish(),
            }),
          ),
        }),
      );
      return result.taskThreads.map((thread) => ({
        threadId: thread.threadId,
        title: thread.title ?? null,
        liveStatus: thread.liveStatus ?? null,
      }));
    } catch {
      return [];
    }
  }

  async function taskCommentCount(taskId: string): Promise<number> {
    try {
      const result = await tasksCall(
        "listComments",
        { taskId },
        z.object({ comments: z.array(z.looseObject({ id: z.string() })) }),
      );
      return result.comments.length;
    } catch {
      return 0;
    }
  }

  async function resolveTaskByKey(taskKey: string): Promise<TaskRow | null> {
    try {
      const result = await tasksCall(
        "getTaskByKey",
        { taskKey },
        z.object({ task: taskRowSchema.nullable() }),
      );
      return result.task;
    } catch {
      return null;
    }
  }

  function pendingComments(
    requestId: string,
  ): { id: string; body: string; created_at: number }[] {
    return db
      .prepare<[string], { id: string; body: string; created_at: number }>(
        `SELECT id, body, created_at FROM request_comments
           WHERE request_id = ? AND delivered_task_id IS NULL
           ORDER BY created_at ASC`,
      )
      .all(requestId);
  }

  function priorityFromTask(raw: string | null | undefined): {
    priority: (typeof PRIORITIES)[number];
    urgent: boolean;
  } {
    if (raw === "urgent") return { priority: "high", urgent: true };
    if (raw === "high") return { priority: "high", urgent: false };
    if (raw === "low" || raw === "none") return { priority: "low", urgent: false };
    return { priority: "normal", urgent: false };
  }

  /** Open, non-snoozed questions keyed by the task they were asked about. */
  function openQuestionsByTaskKey(): Map<string, InboxItem> {
    const now = Date.now();
    const map = new Map<string, InboxItem>();
    for (const item of listItems().open) {
      if (item.taskKey === null) continue;
      if (item.snoozedUntil !== null && item.snoozedUntil > now) continue;
      if (!map.has(item.taskKey)) map.set(item.taskKey, item);
    }
    void now;
    return map;
  }

  function laneForRequest(
    row: RequestRow,
    task: TaskRow | null,
    question: InboxItem | null,
  ): BoardLane {
    // A blocked card belongs where your attention is, whatever its status says.
    if (question !== null) return "needs_you";
    if (row.state === "done" || row.state === "cancelled") return "done";
    if (task !== null && FINISHED_TASK_STATUSES.has(task.status)) return "done";
    if (row.state === "dispatched" || row.state === "in_flight") {
      return "in_progress";
    }
    return "queue";
  }

  function laneForTask(task: TaskRow, question: InboxItem | null): BoardLane {
    if (question !== null) return "needs_you";
    if (FINISHED_TASK_STATUSES.has(task.status)) return "done";
    if (task.status === "in_progress" || task.status === "in_review") {
      return "in_progress";
    }
    return "queue";
  }

  function parseTimestamp(raw: string | null | undefined): number {
    if (raw === null || raw === undefined) return Date.now();
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  const LANE_ORDER: Record<BoardLane, number> = {
    queue: 0,
    in_progress: 1,
    needs_you: 2,
    done: 3,
  };
  const PRIORITY_ORDER: Record<(typeof PRIORITIES)[number], number> = {
    high: 0,
    normal: 1,
    low: 2,
  };

  async function buildBoard(): Promise<{
    cards: BoardCard[];
    tasksError: string | null;
  }> {
    const questions = openQuestionsByTaskKey();
    const requests = db
      .prepare<[], RequestRow>(`SELECT * FROM requests`)
      .all();

    let tasks: TaskRow[] = [];
    let tasksError: string | null = null;
    try {
      tasks = await listAllTasks();
    } catch (error) {
      tasksError = `Tasks plugin unreachable: ${String(error)}`;
      bb.log.warn(tasksError);
    }
    const taskByKey = new Map(tasks.map((task) => [task.key, task]));

    const projectNames = new Map<string, string>();
    try {
      for (const project of await bb.sdk.projects.list({
        includePersonal: true,
      })) {
        projectNames.set(project.id, project.name);
      }
    } catch {
      // Names are decoration; ids still identify the card.
    }

    const cards: BoardCard[] = [];
    const claimedTaskIds = new Set<string>();
    const claimedQuestionIds = new Set<string>();

    for (const row of requests) {
      const task = row.task_key !== null ? taskByKey.get(row.task_key) ?? null : null;
      if (task !== null) claimedTaskIds.add(task.id);
      const question = row.task_key !== null ? questions.get(row.task_key) ?? null : null;
      if (question !== undefined && question !== null) {
        claimedQuestionIds.add(question.id);
      }
      const lane = laneForRequest(row, task, question);
      if (
        lane === "done" &&
        row.closed_at !== null &&
        Date.now() - row.closed_at > DONE_WINDOW_MS
      ) {
        continue;
      }
      const projectId = row.project_id ?? task?.projectId ?? null;
      cards.push({
        id: row.id,
        kind: "request",
        lane,
        title: row.title,
        body: row.body,
        priority: coercePriority(row.priority),
        urgent: row.urgent === 1,
        projectId,
        projectName:
          projectId !== null ? projectNames.get(projectId) ?? null : null,
        taskId: task?.id ?? null,
        taskKey: row.task_key,
        taskStatus: task?.status ?? null,
        chiefThreadId: row.chief_thread_id,
        outcome: row.outcome,
        createdAt: row.created_at,
        commentCount: pendingComments(row.id).length,
        workers: [],
        question,
        movable: true,
        dispatchOnAdvance: row.state === "queued",
      });
    }

    // Work the org created without you. Adopted so this panel is the whole
    // picture and you never have to open the task board.
    for (const task of tasks) {
      if (claimedTaskIds.has(task.id)) continue;
      const question = questions.get(task.key) ?? null;
      if (question !== null) claimedQuestionIds.add(question.id);
      const lane = laneForTask(task, question);
      if (
        lane === "done" &&
        Date.now() - parseTimestamp(task.updatedAt) > DONE_WINDOW_MS
      ) {
        continue;
      }
      const { priority, urgent } = priorityFromTask(task.priority);
      cards.push({
        id: task.id,
        kind: "task",
        lane,
        title: task.title,
        body: task.description ?? "",
        priority,
        urgent,
        projectId: task.projectId ?? null,
        projectName:
          task.projectId !== undefined && task.projectId !== null
            ? projectNames.get(task.projectId) ?? null
            : null,
        taskId: task.id,
        taskKey: task.key,
        taskStatus: task.status,
        chiefThreadId: null,
        outcome: null,
        createdAt: parseTimestamp(task.createdAt),
        commentCount: 0,
        workers: [],
        question,
        movable: true,
        dispatchOnAdvance: false,
      });
    }

    // Questions nobody's card claimed — the common case for a worker asking
    // about work you never queued yourself.
    for (const item of listItems().open) {
      if (claimedQuestionIds.has(item.id)) continue;
      const now = Date.now();
      if (item.snoozedUntil !== null && item.snoozedUntil > now) continue;
      cards.push({
        id: item.id,
        kind: "question",
        lane: "needs_you",
        title: item.task !== "" ? item.task : item.question,
        body: "",
        priority: item.urgent ? "high" : "normal",
        urgent: item.urgent,
        projectId: item.projectId,
        projectName:
          item.projectId !== null
            ? projectNames.get(item.projectId) ?? null
            : null,
        taskId: null,
        taskKey: item.taskKey,
        taskStatus: null,
        chiefThreadId: null,
        outcome: null,
        createdAt: item.createdAt,
        commentCount: 0,
        workers: [],
        question: item,
        movable: false,
        dispatchOnAdvance: false,
      });
    }

    cards.sort(
      (left, right) =>
        LANE_ORDER[left.lane] - LANE_ORDER[right.lane] ||
        Number(right.urgent) - Number(left.urgent) ||
        PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
        left.createdAt - right.createdAt,
    );

    // Enrich the cards a worker could plausibly be on. Each is an extra call
    // into Tasks, so cap it rather than melt a large board.
    const enrich = cards
      .filter((card) => card.taskId !== null && card.lane !== "done")
      .slice(0, MAX_ENRICHED_CARDS);
    await Promise.all(
      enrich.map(async (card) => {
        const taskId = card.taskId;
        if (taskId === null) return;
        const [workers, comments] = await Promise.all([
          taskWorkers(taskId),
          taskCommentCount(taskId),
        ]);
        card.workers = workers;
        card.commentCount += comments;
      }),
    );

    return { cards, tasksError };
  }

  /** Push a lane change back onto the task board, best effort. */
  async function writeTaskLane(
    taskId: string,
    lane: Exclude<BoardLane, "needs_you">,
  ): Promise<string | null> {
    try {
      await tasksCall(
        "boardMove",
        { taskId, status: LANE_TASK_STATUS[lane], authorName: "You" },
        z.looseObject({}),
      );
      return null;
    } catch (error) {
      return `Card moved, but the task board rejected it: ${String(error)}`;
    }
  }

  async function moveCard(
    cardId: string,
    lane: BoardLane,
  ): Promise<{ ok: boolean; error: string | null; dispatchedTo: string | null }> {
    if (lane === "needs_you") {
      return {
        ok: false,
        error:
          "Needs you is derived from open questions — answer or ask one instead of moving a card here.",
        dispatchedTo: null,
      };
    }

    if (cardId.startsWith("inbx_")) {
      return {
        ok: false,
        error: "That card is a question. Answer it and it leaves by itself.",
        dispatchedTo: null,
      };
    }

    const request = requestRow(cardId);
    if (request !== undefined) {
      let dispatchedTo: string | null = null;
      if (lane === "in_progress" && request.state === "queued") {
        const result = await dispatchRequest(cardId);
        if (!result.ok) {
          return { ok: false, error: result.error, dispatchedTo: null };
        }
        dispatchedTo = result.threadId;
      } else if (lane === "queue") {
        db.prepare(
          `UPDATE requests
             SET state = 'queued', queue_pos = ?, closed_at = NULL, outcome = NULL
           WHERE id = ?`,
        ).run(nextQueuePos(), cardId);
        publish();
      } else if (lane === "done") {
        closeRequest(cardId, request.outcome, false);
      } else if (lane === "in_progress" && request.state !== "in_flight") {
        db.prepare(`UPDATE requests SET state = 'dispatched' WHERE id = ?`).run(
          cardId,
        );
        publish();
      }

      // Keep the task board in step so the two can never disagree.
      let error: string | null = null;
      if (request.task_key !== null) {
        const task = await resolveTaskByKey(request.task_key);
        if (task !== null) error = await writeTaskLane(task.id, lane);
      }
      return { ok: true, error, dispatchedTo };
    }

    // An adopted task card: the task board is the only state it has.
    const error = await writeTaskLane(cardId, lane);
    publish();
    return { ok: error === null, error, dispatchedTo: null };
  }

  /** Flush comments written before the task existed, notifying the worker. */
  async function flushPendingComments(
    requestId: string,
    taskId: string,
  ): Promise<void> {
    for (const comment of pendingComments(requestId)) {
      try {
        await tasksCall(
          "createComment",
          { taskId, body: comment.body, notify: true },
          z.looseObject({}),
        );
        db.prepare(
          `UPDATE request_comments SET delivered_task_id = ? WHERE id = ?`,
        ).run(taskId, comment.id);
      } catch (error) {
        bb.log.warn(`comment flush failed for ${comment.id}: ${String(error)}`);
        return;
      }
    }
    publish();
  }

  // ---------------------------------------------------------------- voice

  async function voiceProjects(): Promise<VoiceProject[]> {
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
      }));
    } catch (error) {
      bb.log.debug(`voice: project list unavailable: ${String(error)}`);
      return [];
    }
  }

  /**
   * Transcription accepts a biasing prompt. Feeding it the vocabulary we expect
   * — project names, command words — is what makes "in ecosystem" come back as
   * the project rather than a homophone.
   */
  function composePrompt(projects: readonly VoiceProject[]): string {
    const names = projects.map((project) => project.name).join(", ");
    return [
      "A spoken work request for a task queue.",
      names !== "" ? `Known projects: ${names}.` : "",
      "Common phrases: queue, dispatch, send to chief, urgent, high priority, low priority, details.",
    ]
      .filter((part) => part !== "")
      .join(" ");
  }

  function answerPrompt(item: InboxItem): string {
    return [
      `A spoken answer to the question: ${item.question}`,
      item.options.length > 0
        ? `Expected answers: ${item.options.join(", ")}.`
        : "",
    ]
      .filter((part) => part !== "")
      .join(" ");
  }

  async function transcribe(
    clip: { audioBase64: string; mimeType: string; filename: string },
    prompt?: string,
  ): Promise<string> {
    if (clip.audioBase64.length > MAX_AUDIO_BASE64_LENGTH) {
      throw new Error(
        "That clip is too long to transcribe. Keep voice commands under a couple of minutes.",
      );
    }
    const bytes = Buffer.from(clip.audioBase64, "base64");
    if (bytes.length === 0) {
      throw new Error("No audio was received.");
    }
    // A File (not a bare Blob) so the filename — and therefore the audio
    // format — survives all the way to the transcription backend.
    const file = new File([bytes], clip.filename, { type: clip.mimeType });
    const result = await bb.sdk.system.transcribeVoice(
      prompt === undefined ? { file } : { file, prompt },
    );
    const text = result.text.replace(/\s+/gu, " ").trim();
    if (text === "") {
      throw new Error("Nothing was transcribed. Try again, a little closer.");
    }
    bb.log.info(`transcribed ${bytes.length} bytes of ${clip.mimeType}`);
    return text;
  }

  // ------------------------------------------------------------------ rpc

  bb.rpc.register(rpcContract, {
    list() {
      return listItems();
    },
    answer({ id, answer }) {
      return { ok: resolveItem(id, "answered", answer) };
    },
    dismiss({ id }) {
      return { ok: resolveItem(id, "dismissed", null) };
    },
    retract({ id }) {
      return { ok: retractItem(id) };
    },
    snooze({ id, untilMs }) {
      const result = db
        .prepare(`UPDATE items SET snoozed_until = ? WHERE id = ?`)
        .run(untilMs, id);
      publish();
      return { ok: result.changes > 0 };
    },
    async queue() {
      const chief = await chiefThread();
      return {
        requests: listRequests(),
        chiefThreadId: chief.threadId,
        chiefStatus: chief.status,
        chiefError: chief.error,
      };
    },
    addRequest(input) {
      return {
        id: addRequest({
          title: input.title,
          body: input.body,
          projectId: input.projectId ?? null,
          priority: input.priority,
          urgent: input.urgent,
        }),
      };
    },
    updateRequest({ id, title, body, projectId, priority, urgent }) {
      const row = requestRow(id);
      if (row === undefined) return { ok: false };
      db.prepare(
        `UPDATE requests
           SET title = ?, body = ?, project_id = ?, priority = ?, urgent = ?
         WHERE id = ?`,
      ).run(
        title ?? row.title,
        body ?? row.body,
        projectId === undefined ? row.project_id : projectId,
        priority ?? row.priority,
        urgent === undefined ? row.urgent : urgent ? 1 : 0,
        id,
      );
      publish();
      return { ok: true };
    },
    moveRequest({ id, direction }) {
      return { ok: moveRequest(id, direction) };
    },
    async dispatchRequest({ id }) {
      return await dispatchRequest(id);
    },
    closeRequest({ id, outcome, cancelled }) {
      return { ok: closeRequest(id, outcome ?? null, cancelled === true) };
    },
    reopenRequest({ id }) {
      if (requestRow(id) === undefined) return { ok: false };
      db.prepare(
        `UPDATE requests
           SET state = 'queued', queue_pos = ?, chief_thread_id = NULL,
               dispatched_at = NULL, closed_at = NULL, outcome = NULL
         WHERE id = ?`,
      ).run(nextQueuePos(), id);
      publish();
      return { ok: true };
    },
    async projects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      };
    },
    async board() {
      const [chief, built] = await Promise.all([chiefThread(), buildBoard()]);
      return {
        cards: built.cards,
        chiefThreadId: chief.threadId,
        chiefError: chief.error,
        tasksError: built.tasksError,
      };
    },
    async moveCard({ cardId, lane }) {
      return await moveCard(cardId, lane);
    },
    async cardComments({ cardId }) {
      const request = requestRow(cardId);
      const taskId =
        request !== undefined
          ? request.task_key !== null
            ? (await resolveTaskByKey(request.task_key))?.id ?? null
            : null
          : cardId.startsWith("inbx_")
            ? null
            : cardId;

      const comments: z.infer<typeof boardCommentDto>[] = [];
      let error: string | null = null;
      if (taskId !== null) {
        try {
          const result = await tasksCall(
            "listComments",
            { taskId },
            z.object({
              comments: z.array(
                z.looseObject({
                  id: z.string(),
                  body: z.string(),
                  authorName: z.string(),
                  kind: z.enum(["user", "agent", "system"]),
                  threadId: z.string().nullish(),
                  threadTitle: z.string().nullish(),
                  createdAt: z.string(),
                  notifiedCount: z.number(),
                }),
              ),
            }),
          );
          for (const comment of result.comments) {
            comments.push({
              id: comment.id,
              body: comment.body,
              authorName: comment.authorName,
              kind: comment.kind,
              threadId: comment.threadId ?? null,
              threadTitle: comment.threadTitle ?? null,
              createdAt: comment.createdAt,
              notifiedCount: comment.notifiedCount,
              pending: false,
            });
          }
        } catch (caught) {
          error = String(caught);
        }
      }
      if (request !== undefined) {
        for (const pending of pendingComments(request.id)) {
          comments.push({
            id: pending.id,
            body: pending.body,
            authorName: "You",
            kind: "user",
            threadId: null,
            threadTitle: null,
            createdAt: new Date(pending.created_at).toISOString(),
            notifiedCount: 0,
            pending: true,
          });
        }
      }
      // Newest first: the latest context is what you need when you open a card.
      comments.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
      return { comments, canNotify: taskId !== null, error };
    },
    async addCardComment({ cardId, body }) {
      if (cardId.startsWith("inbx_")) {
        return {
          ok: false,
          notified: 0,
          pending: false,
          error: "Answer the question instead of commenting on it.",
        };
      }
      const request = requestRow(cardId);
      const taskId =
        request !== undefined
          ? request.task_key !== null
            ? (await resolveTaskByKey(request.task_key))?.id ?? null
            : null
          : cardId;

      // No task yet: hold it locally and deliver when Chief acks a task key.
      if (taskId === null) {
        if (request === undefined) {
          return { ok: false, notified: 0, pending: false, error: "No such card." };
        }
        db.prepare(
          `INSERT INTO request_comments (id, request_id, created_at, body)
           VALUES (?, ?, ?, ?)`,
        ).run(newId("ccm"), request.id, Date.now(), body);
        publish();
        return { ok: true, notified: 0, pending: true, error: null };
      }

      try {
        const result = await tasksCall(
          "createComment",
          { taskId, body, notify: true },
          z.object({
            comment: z.looseObject({ notifiedCount: z.number() }),
          }),
        );
        publish();
        return {
          ok: true,
          notified: result.comment.notifiedCount,
          pending: false,
          error: null,
        };
      } catch (error) {
        return { ok: false, notified: 0, pending: false, error: String(error) };
      }
    },
    async voiceStatus() {
      try {
        const config = await bb.sdk.system.config();
        return {
          enabled: config.voiceTranscriptionEnabled,
          error: config.voiceTranscriptionEnabled
            ? null
            : "Voice transcription is not configured on this server. Set a transcription model (or OPENAI_API_KEY) to enable it.",
        };
      } catch (error) {
        return { enabled: false, error: String(error) };
      }
    },
    async transcribe(input) {
      return { text: await transcribe(input, input.prompt) };
    },
    async voiceCompose(input) {
      const projects = await voiceProjects();
      const transcript = await transcribe(input, composePrompt(projects));
      const parsed = parseVoiceCommand(transcript, projects);
      return {
        transcript: parsed.transcript,
        title: parsed.title,
        body: parsed.body,
        priority: parsed.priority,
        urgent: parsed.urgent,
        projectId: parsed.projectId,
        projectName: parsed.projectName,
        intent: parsed.intent,
        understood: parsed.understood,
      };
    },
    async voiceAnswer(input) {
      const row = getItem(input.itemId);
      if (row === undefined) {
        throw new Error(`No item ${input.itemId}.`);
      }
      const item = toItem(row);
      const transcript = await transcribe(input, answerPrompt(item));
      const best = matchSpokenOption(transcript, item.options);
      return {
        transcript,
        option: best?.option ?? null,
        confidence: best?.confidence ?? 0,
        options: matchSpokenOptions(transcript, item.options),
      };
    },
    async parseVoice({ transcript }) {
      const parsed = parseVoiceCommand(transcript, await voiceProjects());
      return {
        transcript: parsed.transcript,
        title: parsed.title,
        body: parsed.body,
        priority: parsed.priority,
        urgent: parsed.urgent,
        projectId: parsed.projectId,
        projectName: parsed.projectName,
        intent: parsed.intent,
        understood: parsed.understood,
      };
    },
  });

  // ------------------------------------------------------------------ cli

  interface Parsed {
    flags: Record<string, string[]>;
    positional: string[];
  }

  function parseArgv(argv: string[]): Parsed {
    const flags: Record<string, string[]> = {};
    const positional: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === undefined) continue;
      if (!token.startsWith("--")) {
        positional.push(token);
        continue;
      }
      const equals = token.indexOf("=");
      const key = equals >= 0 ? token.slice(2, equals) : token.slice(2);
      let value = equals >= 0 ? token.slice(equals + 1) : null;
      if (value === null) {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          index += 1;
        } else {
          value = "true";
        }
      }
      (flags[key] ??= []).push(value);
    }
    return { flags, positional };
  }

  const first = (parsed: Parsed, key: string): string | undefined =>
    parsed.flags[key]?.[0];
  const has = (parsed: Parsed, key: string): boolean =>
    parsed.flags[key] !== undefined;
  const numberFlag = (parsed: Parsed, key: string): number | undefined => {
    const raw = first(parsed, key);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  /** A flag written bare (`--body`) carries the sentinel "true", not a value. */
  const textFlag = (parsed: Parsed, key: string): string | undefined => {
    const raw = first(parsed, key);
    return raw === "true" ? undefined : raw;
  };

  function itemLine(item: InboxItem): string {
    return [
      item.urgent ? "!" : "",
      item.id,
      `[${item.kind}]`,
      item.task !== "" ? `${item.task}:` : "",
      item.question,
      item.askedBy !== null ? `(${item.askedBy})` : "",
      item.snoozedUntil !== null && item.snoozedUntil > Date.now()
        ? `(snoozed until ${new Date(item.snoozedUntil).toISOString()})`
        : "",
    ]
      .filter((bit) => bit !== "")
      .join(" ");
  }

  function requestLine(request: InboxRequest): string {
    return [
      request.urgent ? "!" : "",
      request.id,
      `[${request.state}]`,
      request.priority !== "normal" ? `(${request.priority})` : "",
      request.title,
      request.taskKey !== null ? `→ ${request.taskKey}` : "",
      request.blockedBy !== null ? `BLOCKED by ${request.blockedBy}` : "",
      request.outcome !== null ? `— ${request.outcome}` : "",
    ]
      .filter((bit) => bit !== "")
      .join(" ");
  }

  async function waitForItem(
    id: string,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<ItemRow | undefined> {
    const deadline = Date.now() + timeoutSec * 1_000;
    for (;;) {
      const row = getItem(id);
      if (row === undefined) return undefined;
      if (row.status !== "open") return row;
      if (Date.now() >= deadline || signal?.aborted === true) return row;
      await sleep(500, signal);
    }
  }

  function clip(text: string): string {
    if (Buffer.byteLength(text, "utf8") <= PLUGIN_CLI_OUTPUT_MAX_BYTES - 1_024) {
      return text;
    }
    return `${text.slice(0, 100_000)}\n… output truncated; narrow the query.`;
  }

  bb.cli.register({
    name: "inbox",
    summary: "Your command center: ask the user, and pick up what they queued",
    commands: [
      {
        name: "ask",
        summary: "Ask the user a question",
        usage:
          'bb inbox ask --task "…" --question "…" [--option A --option B | --multi | --input] [--asked-by "…"] [--urgent] [--wait]',
      },
      {
        name: "review",
        summary: "Ask the user to look at a thread or URL",
        usage:
          'bb inbox review --task "…" --question "…" --thread <id> | --url <url> [--option Approve]',
      },
      {
        name: "list",
        summary: "Show the question queue",
        usage: "bb inbox list [--all] [--json]",
      },
      {
        name: "get",
        summary: "Read one item",
        usage: "bb inbox get <id> [--json]",
      },
      {
        name: "wait",
        summary: "Block until an item is answered",
        usage: "bb inbox wait <id> [--timeout-sec 600] [--json]",
      },
      {
        name: "done",
        summary: "Withdraw a question you no longer need answered",
        usage: "bb inbox done <id>",
      },
      {
        name: "answers",
        summary: "Recently resolved items, for a replacement thread to catch up",
        usage: "bb inbox answers [--since-min 120] [--json]",
      },
      {
        name: "snooze",
        summary: "Snooze an item on the user's behalf",
        usage: "bb inbox snooze <id> --hours N | --minutes N | --clear",
      },
      {
        name: "add",
        summary: "Queue a request in the command center",
        usage:
          'bb inbox add "<title>" [--body "…"] [--project <id>] [--priority low|normal|high] [--urgent]',
      },
      {
        name: "queue",
        summary: "Show the command center request lane",
        usage: "bb inbox queue [--all] [--json]",
      },
      {
        name: "ack",
        summary: "Acknowledge a dispatched request with its task key",
        usage: "bb inbox ack <id> --task-key ABC-12",
      },
      {
        name: "close",
        summary: "Close a request with an outcome",
        usage: 'bb inbox close <id> [--outcome "…"] [--cancelled]',
      },
      {
        name: "dispatch",
        summary: "Send a queued request to Chief (normally the Captain's call)",
        usage: "bb inbox dispatch <id>",
      },
      {
        name: "voice-parse",
        summary:
          "Show how a spoken phrase parses into a request, without a microphone",
        usage: 'bb inbox voice-parse "bump the SDK, high priority, dispatch" [--json]',
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      const parsed = parseArgv(rest);
      const json = has(parsed, "json");

      switch (command) {
        case "ask":
        case "review": {
          const question = first(parsed, "question");
          if (question === undefined) {
            return { exitCode: 1, stderr: "--question is required." };
          }
          const options = parsed.flags["option"] ?? [];
          const isReview = command === "review";
          const reviewThreadId = first(parsed, "thread") ?? null;
          const reviewUrl = first(parsed, "url") ?? null;
          if (isReview && reviewThreadId === null && reviewUrl === null) {
            return {
              exitCode: 1,
              stderr: "review needs --thread <id> or --url <url>.",
            };
          }
          const kind = isReview
            ? "review"
            : has(parsed, "multi")
              ? "multi"
              : has(parsed, "input")
                ? "text"
                : options.length > 0
                  ? "options"
                  : "ack";
          const id = insertItem({
            task: first(parsed, "task") ?? "",
            question,
            kind,
            options,
            placeholder: textFlag(parsed, "placeholder") ?? null,
            taskKey: textFlag(parsed, "task-key") ?? null,
            threadId: first(parsed, "ask-thread") ?? ctx.threadId ?? null,
            projectId: first(parsed, "project") ?? ctx.projectId ?? null,
            askedBy: textFlag(parsed, "asked-by") ?? null,
            reviewThreadId: isReview ? reviewThreadId : null,
            reviewUrl: isReview ? reviewUrl : null,
            urgent: has(parsed, "urgent"),
            notify: !has(parsed, "no-notify"),
          });

          if (!has(parsed, "wait")) {
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify({ id, status: "open" })
                : `Asked (${id}). The answer will be delivered into this thread when the user resolves it.`,
            };
          }

          const resolved = await waitForItem(
            id,
            numberFlag(parsed, "timeout-sec") ?? 600,
            ctx.signal,
          );
          if (resolved === undefined || resolved.status === "open") {
            return {
              exitCode: 1,
              stdout: json ? JSON.stringify({ id, status: "open" }) : "",
              stderr: `Timed out waiting for ${id}. It is still open; the answer will be delivered here when it arrives.`,
            };
          }
          // Answered inline — suppress the duplicate push into this thread.
          db.prepare(
            `UPDATE items SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`,
          ).run(Date.now(), id);
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(toItem(resolved))
              : (resolved.answer ?? "Dismissed without an answer."),
          };
        }

        case "list": {
          const { open, snoozed, resolved } = listItems();
          if (json) {
            return {
              exitCode: 0,
              stdout: clip(
                JSON.stringify(
                  has(parsed, "all")
                    ? { open, snoozed, resolved }
                    : { open, snoozed },
                ),
              ),
            };
          }
          const lines = [
            open.length > 0 ? "Open:" : "Open: nothing",
            ...open.map(itemLine),
            ...(snoozed.length > 0
              ? ["", "Snoozed:", ...snoozed.map(itemLine)]
              : []),
            ...(has(parsed, "all") && resolved.length > 0
              ? ["", "Resolved:", ...resolved.map(itemLine)]
              : []),
          ];
          return { exitCode: 0, stdout: clip(lines.join("\n")) };
        }

        case "get": {
          const id = parsed.positional[0];
          if (id === undefined) {
            return { exitCode: 1, stderr: "Usage: bb inbox get <id>" };
          }
          const row = getItem(id);
          if (row === undefined) {
            return { exitCode: 1, stderr: `No item ${id}.` };
          }
          const item = toItem(row);
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(item)
              : [
                  itemLine(item),
                  `status: ${item.status}`,
                  item.answer !== null ? `answer: ${item.answer}` : "",
                  item.priorAnswer !== null
                    ? `withdrawn answer: ${item.priorAnswer}`
                    : "",
                ]
                  .filter((line) => line !== "")
                  .join("\n"),
          };
        }

        case "wait": {
          const id = parsed.positional[0];
          if (id === undefined) {
            return { exitCode: 1, stderr: "Usage: bb inbox wait <id>" };
          }
          const row = await waitForItem(
            id,
            numberFlag(parsed, "timeout-sec") ?? 600,
            ctx.signal,
          );
          if (row === undefined) {
            return { exitCode: 1, stderr: `No item ${id}.` };
          }
          if (row.status === "open") {
            return { exitCode: 1, stderr: `Still open: ${id}.` };
          }
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(toItem(row))
              : (row.answer ?? "Dismissed without an answer."),
          };
        }

        case "done": {
          const id = parsed.positional[0];
          if (id === undefined) {
            return { exitCode: 1, stderr: "Usage: bb inbox done <id>" };
          }
          if (getItem(id) === undefined) {
            return { exitCode: 1, stderr: `No item ${id}.` };
          }
          // Withdrawn by the asker: resolve it without delivering anything.
          db.prepare(
            `UPDATE items
               SET status = 'dismissed', notify = 0, resolved_at = ?
             WHERE id = ?`,
          ).run(Date.now(), id);
          publish();
          return { exitCode: 0, stdout: `Withdrew ${id}.` };
        }

        case "answers": {
          const sinceMin = numberFlag(parsed, "since-min") ?? 120;
          const rows = db
            .prepare<[number], ItemRow>(
              `SELECT * FROM items
                 WHERE status IN ('answered','dismissed') AND resolved_at >= ?
                 ORDER BY resolved_at DESC LIMIT 50`,
            )
            .all(Date.now() - sinceMin * 60_000)
            .map(toItem);
          return {
            exitCode: 0,
            stdout: clip(
              json
                ? JSON.stringify({ answers: rows })
                : rows.length > 0
                  ? rows
                      .map(
                        (item) =>
                          `${item.id} ${item.task}: ${item.question}\n  → ${item.answer ?? "(dismissed)"}`,
                      )
                      .join("\n")
                  : `Nothing resolved in the last ${sinceMin} minutes.`,
            ),
          };
        }

        case "snooze": {
          const id = parsed.positional[0];
          if (id === undefined) {
            return {
              exitCode: 1,
              stderr: "Usage: bb inbox snooze <id> --hours N | --minutes N | --clear",
            };
          }
          if (getItem(id) === undefined) {
            return { exitCode: 1, stderr: `No item ${id}.` };
          }
          let until: number | null = null;
          if (!has(parsed, "clear")) {
            const hours = numberFlag(parsed, "hours") ?? 0;
            const minutes = numberFlag(parsed, "minutes") ?? 0;
            if (hours === 0 && minutes === 0) {
              return {
                exitCode: 1,
                stderr: "Pass --hours N, --minutes N, or --clear.",
              };
            }
            until = Date.now() + hours * 3_600_000 + minutes * 60_000;
          }
          db.prepare(`UPDATE items SET snoozed_until = ? WHERE id = ?`).run(
            until,
            id,
          );
          publish();
          return {
            exitCode: 0,
            stdout:
              until !== null
                ? `Snoozed ${id} until ${new Date(until).toISOString()}.`
                : `Woke ${id}.`,
          };
        }

        case "add": {
          const title =
            parsed.positional.join(" ").trim() || (textFlag(parsed, "title") ?? "");
          if (title === "") {
            return { exitCode: 1, stderr: 'Usage: bb inbox add "<title>"' };
          }
          const id = addRequest({
            title,
            body: textFlag(parsed, "body") ?? "",
            projectId:
              first(parsed, "project") ??
              (await settings.get()).defaultProject ??
              null,
            priority: coercePriority(first(parsed, "priority")),
            urgent: has(parsed, "urgent"),
          });
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({ id, state: "queued" })
              : `Queued ${id}. It waits in the command center until the Captain dispatches it.`,
          };
        }

        case "queue": {
          const requests = listRequests().filter((request) =>
            has(parsed, "all")
              ? true
              : request.state !== "done" && request.state !== "cancelled",
          );
          return {
            exitCode: 0,
            stdout: clip(
              json
                ? JSON.stringify({ requests })
                : requests.length > 0
                  ? requests.map(requestLine).join("\n")
                  : "The request lane is empty.",
            ),
          };
        }

        case "ack": {
          const id = parsed.positional[0];
          const taskKey = textFlag(parsed, "task-key");
          if (id === undefined || taskKey === undefined) {
            return {
              exitCode: 1,
              stderr: "Usage: bb inbox ack <id> --task-key ABC-12",
            };
          }
          if (!ackRequest(id, taskKey)) {
            return { exitCode: 1, stderr: `No request ${id}.` };
          }
          return { exitCode: 0, stdout: `Acked ${id} → ${taskKey}.` };
        }

        case "close": {
          const id = parsed.positional[0];
          if (id === undefined) {
            return {
              exitCode: 1,
              stderr: 'Usage: bb inbox close <id> [--outcome "…"] [--cancelled]',
            };
          }
          const cancelled = has(parsed, "cancelled");
          if (!closeRequest(id, textFlag(parsed, "outcome") ?? null, cancelled)) {
            return { exitCode: 1, stderr: `No request ${id}.` };
          }
          return {
            exitCode: 0,
            stdout: `Closed ${id} as ${cancelled ? "cancelled" : "done"}.`,
          };
        }

        case "dispatch": {
          const id = parsed.positional[0];
          if (id === undefined) {
            return { exitCode: 1, stderr: "Usage: bb inbox dispatch <id>" };
          }
          const result = await dispatchRequest(id);
          if (!result.ok) {
            return { exitCode: 1, stderr: result.error ?? "Dispatch failed." };
          }
          return {
            exitCode: 0,
            stdout: `Dispatched ${id} to Chief (${result.threadId}).`,
          };
        }

        case "voice-parse": {
          const transcript = parsed.positional.join(" ").trim();
          if (transcript === "") {
            return {
              exitCode: 1,
              stderr: 'Usage: bb inbox voice-parse "<spoken phrase>"',
            };
          }
          const result = parseVoiceCommand(transcript, await voiceProjects());
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(result)
              : [
                  `title:    ${result.title}`,
                  result.body !== "" ? `detail:   ${result.body}` : "",
                  `priority: ${result.priority}${result.urgent ? " (urgent)" : ""}`,
                  `project:  ${result.projectName ?? "(let Chief pick)"}`,
                  `intent:   ${result.intent}`,
                ]
                  .filter((line) => line !== "")
                  .join("\n"),
          };
        }

        default:
          return {
            exitCode: 1,
            stderr: `unknown command "${command ?? ""}". Try: ask, review, list, get, wait, done, answers, snooze, add, queue, ack, close, dispatch, voice-parse`,
          };
      }
    },
  });

  bb.log.info("inbox ready");
}

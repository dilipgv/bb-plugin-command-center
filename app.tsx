/**
 * The command center panel: a composer over a five-lane board.
 *
 * Queue → In progress → In review → Done are yours to drag; the last step is
 * deliberately manual, because signing work off is the Captain's call. Needs you
 * is derived from open questions, so it takes no drops — cards arrive when an
 * agent asks something and leave when you answer.
 *
 * Cards come from three places and are drawn identically: requests you queued,
 * tasks the org created without you, and bare questions. This is meant to be
 * the only surface you look at, so anything a card needs — workers, comments,
 * the question itself — opens here rather than sending you to another panel.
 */
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  ThreadChat,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useShortcut } from "@/hooks/useShortcut";
import { useVoiceCapture } from "@/hooks/useVoiceCapture";
import { CardViewer } from "./CardViewer";
import {
  Chip,
  HeardLine,
  MicButton,
  relative,
  toastArchiveResult,
  toastUnarchiveResult,
  untilLabel,
  type VoiceAvailability,
} from "./card-parts";
import { mountNavBadge } from "./nav-badge";
import type {
  BoardCard,
  BoardLane,
  ChiefNavGroup,
  ChiefNavNeedsInput,
  ChiefNavThread,
  InboxItem,
  InboxRequest,
  rpcContract,
} from "./server";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Priority = InboxRequest["priority"];
type VoiceCapture = ReturnType<typeof useVoiceCapture>;

const PRIORITIES: Priority[] = ["low", "normal", "high"];

/** Shortcuts live in plugin settings, so a missing value falls back silently. */
function stringSetting(
  values: Record<string, string | boolean> | undefined,
  key: string,
  fallback: string,
): string {
  const value = values?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** "Add detail (⌥D)" — only when the shortcut actually parsed. */
function withShortcut(label: string, hint: string | null): string {
  return hint === null ? label : `${label} (${hint})`;
}






/** One shared read of the board plus the question queue behind it. */
function useCommandCenter(rpc: Rpc) {
  const [items, setItems] = React.useState<{
    open: InboxItem[];
    snoozed: InboxItem[];
    resolved: InboxItem[];
  }>({ open: [], snoozed: [], resolved: [] });
  const [board, setBoard] = React.useState<{
    cards: BoardCard[];
    chiefThreadId: string | null;
    chiefError: string | null;
    tasksError: string | null;
  }>({
    cards: [],
    chiefThreadId: null,
    chiefError: null,
    tasksError: null,
  });
  const [isLoading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const [nextItems, nextBoard] = await Promise.all([
        rpc.call("list"),
        rpc.call("board"),
      ]);
      setItems(nextItems);
      setBoard(nextBoard);
    } catch (error) {
      toast.error(`Inbox failed to load: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("changed", () => {
    void refresh();
  });

  // Snoozes come due on a timer nobody signals — keep the lanes honest.
  React.useEffect(() => {
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const connection = useRealtimeConnectionState();
  const wasConnected = React.useRef(false);
  React.useEffect(() => {
    if (connection === "connected" && wasConnected.current) void refresh();
    if (connection === "connected") wasConnected.current = true;
  }, [connection, refresh]);

  return { items, board, isLoading, refresh };
}

// ------------------------------------------------------------------ chrome


// ---------------------------------------------------------------- composer

interface Harness {
  id: string;
  label: string;
  models: { id: string; label: string }[];
}

function Composer({
  rpc,
  projects,
  defaultProjectId,
  harnesses,
  workflows,
  voice,
  onAdded,
}: {
  rpc: Rpc;
  projects: { id: string; name: string }[];
  defaultProjectId: string | null;
  harnesses: {
    list: Harness[];
    defaultProviderId: string | null;
    defaultModel: string | null;
  };
  workflows: { id: string; name: string; stepCount: number }[];
  voice: VoiceAvailability;
  onAdded: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [showBody, setShowBody] = React.useState(false);
  const [projectId, setProjectId] = React.useState("");
  const [priority, setPriority] = React.useState<Priority>("normal");
  const [urgent, setUrgent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // The selector IS the default: whatever is showing is what the next request
  // runs on, and changing it is remembered.
  const [providerId, setProviderId] = React.useState("");
  const [model, setModel] = React.useState("");
  const [workflowName, setWorkflowName] = React.useState("");

  React.useEffect(() => {
    setProviderId(harnesses.defaultProviderId ?? "");
    setModel(harnesses.defaultModel ?? "");
  }, [harnesses.defaultProviderId, harnesses.defaultModel]);

  // The `defaultProject` setting starts the picker pre-selected; picking a
  // different project for one request does not change the setting.
  React.useEffect(() => {
    setProjectId(defaultProjectId ?? "");
  }, [defaultProjectId]);

  const models =
    harnesses.list.find((harness) => harness.id === providerId)?.models ?? [];

  const rememberDefault = (nextProvider: string, nextModel: string) => {
    void rpc
      .call("setDispatchDefault", {
        providerId: nextProvider === "" ? null : nextProvider,
        model: nextModel === "" ? null : nextModel,
      })
      .catch((error: unknown) => toast.error(String(error)));
  };
  const [heard, setHeard] = React.useState<{
    transcript: string;
    understood: string[];
    intent: "queue" | "dispatch";
  } | null>(null);

  /**
   * Voice fills the form; it never sends. A spoken "dispatch" is recorded as
   * intent and highlights the button, because acting on a mishearing would put
   * wrong work in front of Chief.
   */
  const capture = useVoiceCapture({
    onClip: async (clip) => {
      const result = await rpc.call("voiceCompose", {
        audioBase64: clip.base64,
        mimeType: clip.mimeType,
        filename: clip.filename,
      });
      if (result.title !== "") setTitle(result.title);
      if (result.body !== "") {
        setBody(result.body);
        setShowBody(true);
      }
      setPriority(result.priority);
      setUrgent(result.urgent);
      if (result.projectId !== null) setProjectId(result.projectId);
      setHeard({
        transcript: result.transcript,
        understood: result.understood,
        intent: result.intent,
      });
      if (result.title === "") {
        toast.warning("Heard you, but could not find the task in that.");
      }
    },
    onError: (message) => toast.error(message),
  });

  const titleRef = React.useRef<HTMLInputElement | null>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement | null>(null);

  const openDetail = React.useCallback(() => {
    setShowBody(true);
    // The textarea does not exist until after this render.
    requestAnimationFrame(() => bodyRef.current?.focus());
  }, []);

  const toggleDetail = React.useCallback(() => {
    setShowBody((current) => {
      if (current) {
        requestAnimationFrame(() => titleRef.current?.focus());
        return false;
      }
      requestAnimationFrame(() => bodyRef.current?.focus());
      return true;
    });
  }, []);

  const { values: settings } = useSettings();
  const voiceKeys = useShortcut(
    stringSetting(settings, "voiceShortcut", "alt+v"),
    capture.toggle,
    voice.enabled && capture.isSupported,
  );
  const detailKeys = useShortcut(
    stringSetting(settings, "detailShortcut", "alt+d"),
    toggleDetail,
  );

  const submit = async (dispatchNow: boolean) => {
    const trimmed = title.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    try {
      const { id } = await rpc.call("addRequest", {
        title: trimmed,
        body: body.trim(),
        projectId: projectId === "" ? null : projectId,
        priority,
        urgent,
        providerId: providerId === "" ? null : providerId,
        model: model === "" ? null : model,
        workflowName: workflowName === "" ? null : workflowName,
      });
      if (dispatchNow) {
        const result = await rpc.call("dispatchRequest", { id });
        if (result.ok) toast.success("Dispatched");
        else toast.error(result.error ?? "Dispatch failed");
      } else {
        toast.success("Queued");
      }
      setTitle("");
      setBody("");
      setShowBody(false);
      setUrgent(false);
      setHeard(null);
      onAdded();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          ref={titleRef}
          value={title}
          placeholder={
            capture.isRecording
              ? "Listening… say the work, then any of: urgent, high priority, in <project>, dispatch"
              : "What needs doing? Enter to queue, ⌘Enter to dispatch"
          }
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            // Shift+Enter is "there is more to say" everywhere else, so it
            // opens the detail box rather than submitting.
            if (event.shiftKey) {
              openDetail();
              return;
            }
            void submit(event.metaKey || event.ctrlKey);
          }}
        />
        <MicButton
          capture={capture}
          availability={voice}
          label={withShortcut("Dictate a request", voiceKeys.label)}
        />
      </div>

      {heard !== null ? (
        <HeardLine
          transcript={heard.transcript}
          understood={heard.understood}
          hint={
            heard.intent === "dispatch"
              ? "You said dispatch — review it, then press Dispatch."
              : "Review it, then press Queue."
          }
        />
      ) : null}
      {showBody ? (
        <textarea
          ref={bodyRef}
          value={body}
          placeholder="Context, constraints, links — anything the routing should account for."
          rows={3}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              titleRef.current?.focus();
              return;
            }
            // Enter is a newline here; only the modifier submits.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit(true);
            }
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">Pick the project automatically</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(event) => setPriority(event.target.value as Priority)}
          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {harnesses.list.length > 0 ? (
          <>
            <select
              value={providerId}
              aria-label="Harness to run this on"
              onChange={(event) => {
                const next = event.target.value;
                setProviderId(next);
                // A model belongs to one harness; do not carry it across.
                setModel("");
                rememberDefault(next, "");
              }}
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Default harness</option>
              {harnesses.list.map((harness) => (
                <option key={harness.id} value={harness.id}>
                  {harness.label}
                </option>
              ))}
            </select>
            {models.length > 0 ? (
              <select
                value={model}
                aria-label="Model for that harness"
                onChange={(event) => {
                  const next = event.target.value;
                  setModel(next);
                  rememberDefault(providerId, next);
                }}
                className="h-7 max-w-[11rem] rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Harness default model</option>
                {models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            ) : null}
          </>
        ) : null}
        {workflows.length > 0 ? (
          <select
            value={workflowName}
            aria-label="Workflow for the architect to follow"
            onChange={(event) => setWorkflowName(event.target.value)}
            className="h-7 max-w-[11rem] rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">No workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.name}>
                {workflow.name} ({workflow.stepCount})
              </option>
            ))}
          </select>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={urgent}
          onClick={() => setUrgent((current) => !current)}
        >
          Urgent
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={showBody}
          aria-label={withShortcut(
            showBody ? "Hide detail" : "Add detail",
            detailKeys.label,
          )}
          onClick={toggleDetail}
        >
          {showBody ? "Hide detail" : "Add detail"}
          {detailKeys.label !== null ? (
            <span className="text-[10px] text-muted-foreground">
              {detailKeys.label}
            </span>
          ) : null}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || title.trim() === ""}
            onClick={() => void submit(false)}
          >
            Queue
          </Button>
          <Button
            size="sm"
            disabled={busy || title.trim() === ""}
            className={
              heard?.intent === "dispatch" ? "ring-2 ring-ring" : undefined
            }
            onClick={() => void submit(true)}
          >
            Dispatch
          </Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- items


// ------------------------------------------------------------------- board

const LANE_TITLES: Record<BoardLane, string> = {
  queue: "Queue",
  in_progress: "In progress",
  in_review: "In review",
  needs_you: "Needs you",
  done: "Done",
};

const LANES_ORDER: BoardLane[] = [
  "queue",
  "in_progress",
  "in_review",
  "needs_you",
  "done",
];

/** Needs you is derived from open questions, so nothing can be dropped there. */
const DROPPABLE_LANES: BoardLane[] = [
  "queue",
  "in_progress",
  "in_review",
  "done",
];

const DRAG_MIME = "application/x-bb-inbox-card";

function workerTone(liveStatus: string | null): string {
  switch (liveStatus) {
    case "working":
    case "starting":
      return "text-foreground";
    case "failed":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

/** Longest option label a lane-width button can show without truncating. */
const QUICK_ANSWER_MAX_LABEL = 24;

function BoardCardTile({
  card,
  rpc,
  onRead,
  onArchive,
  onDragStart,
}: {
  card: BoardCard;
  rpc: Rpc;
  onRead: (card: BoardCard) => void;
  onArchive: (card: BoardCard) => void;
  onDragStart: (card: BoardCard) => void;
}) {
  const question = card.question;
  const canQuickAnswer =
    question !== null &&
    question.options.length > 0 &&
    question.options.every(
      (option) => option.length <= QUICK_ANSWER_MAX_LABEL,
    );
  // This tile and the reader's own answer buttons are two separate mounted
  // components for the same question — each needs its own guard, or a click
  // here plus one in the reader (or two quick clicks before this tile
  // disappears) fire two "answer" calls that the server used to both accept,
  // each re-sending the whole question into the asker's thread.
  const [answering, setAnswering] = React.useState(false);
  return (
    <article
      draggable={card.movable}
      onDragStart={(event) => {
        if (!card.movable) return;
        event.dataTransfer.setData(DRAG_MIME, card.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(card);
      }}
      className={`group min-w-0 space-y-1.5 overflow-hidden rounded-lg border bg-card p-2.5 ${
        card.movable ? "cursor-grab active:cursor-grabbing" : ""
      } ${card.urgent ? "border-destructive/50" : "border-border"} hover:border-ring`}
    >
      <button
        type="button"
        className="w-full text-left"
        title="Open the reading view"
        onClick={() => onRead(card)}
      >
        <p className="line-clamp-3 text-sm text-foreground">{card.title}</p>
      </button>

      <div className="flex flex-wrap items-center gap-1">
        {card.stalled ? <Chip tone="urgent">stalled</Chip> : null}
        {card.urgent ? <Chip tone="urgent">urgent</Chip> : null}
        {card.priority !== "normal" ? <Chip>{card.priority}</Chip> : null}
        {card.taskKey !== null ? <Chip tone="accent">{card.taskKey}</Chip> : null}
        {card.kind === "question" ? <Chip tone="urgent">question</Chip> : null}
        {card.commentCount > 0 ? <Chip>{card.commentCount} 💬</Chip> : null}
        {card.pullRequests.map((pullRequest) => (
          <Chip
            key={pullRequest.url}
            tone={pullRequest.state === "open" ? "accent" : "muted"}
          >
            PR #{pullRequest.number} {pullRequest.state}
          </Chip>
        ))}
        {card.pullRequestsUnavailable && card.pullRequests.length === 0 ? (
          <Chip>PR unknown</Chip>
        ) : null}
        {card.workers.length > 0 ? (
          <Chip tone="accent">{card.workers.length} 🧵</Chip>
        ) : null}
        <button
          type="button"
          aria-label="Archive this card"
          title="Archive"
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onArchive(card);
          }}
        >
          <Icon name="Archive" className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {question === null && card.stalled ? (
        <div className="space-y-1.5 border-t border-border/60 pt-1.5">
          <p className="text-xs text-muted-foreground">
            Went quiet while in progress. Nobody has said why.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="max-w-full"
            onClick={() => onRead(card)}
          >
            Look at it
          </Button>
        </div>
      ) : null}

      {question !== null ? (
        <div className="space-y-1.5 border-t border-border/60 pt-1.5">
          <p className="line-clamp-4 text-xs text-muted-foreground">
            {question.question}
          </p>
          <div className="flex flex-wrap gap-1">
            {canQuickAnswer
              ? question.options.slice(0, 3).map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant="outline"
                    className="max-w-full"
                    disabled={answering}
                    onClick={() => {
                      if (answering) return;
                      setAnswering(true);
                      void rpc
                        .call("answer", { id: question.id, answer: option })
                        .then((result) => {
                          if (result.ok) toast.success("Answered");
                          // ok:false means this question was already resolved
                          // by another click (this tile, or the reader open at
                          // the same time) — the realtime refresh will remove
                          // the card; nothing to report as an error.
                        })
                        .catch((error: unknown) => toast.error(String(error)))
                        .finally(() => setAnswering(false));
                    }}
                  >
                    {option}
                  </Button>
                ))
              : null}
            <Button
              size="sm"
              variant={canQuickAnswer ? "ghost" : "outline"}
              className="max-w-full"
              onClick={() => onRead(card)}
            >
              {canQuickAnswer && question.options.length > 3
                ? "More…"
                : canQuickAnswer
                  ? "Answer…"
                  : `Answer — ${question.options.length} options`}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function BoardColumn({
  lane,
  cards,
  rpc,
  isCompact,
  onRead,
  onArchive,
  onDragStart,
  onDrop,
}: {
  lane: BoardLane;
  cards: BoardCard[];
  rpc: Rpc;
  isCompact: boolean;
  onRead: (card: BoardCard) => void;
  onArchive: (card: BoardCard) => void;
  onDragStart: (card: BoardCard) => void;
  onDrop: (lane: BoardLane, cardId: string) => void;
}) {
  const [isOver, setOver] = React.useState(false);
  const droppable = DROPPABLE_LANES.includes(lane);

  return (
    <section
      className={`flex flex-col gap-2 rounded-lg border p-2 ${
        // Columns share the centred board evenly rather than sitting at a fixed
        // width, so the four lanes stay balanced under the composer.
        isCompact ? "w-full" : "min-w-0 flex-1 basis-0"
      } ${isOver ? "border-ring bg-state-hover" : "border-border/60"}`}
      onDragOver={(event) => {
        if (!droppable) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        if (!droppable) return;
        event.preventDefault();
        const cardId = event.dataTransfer.getData(DRAG_MIME);
        if (cardId !== "") onDrop(lane, cardId);
      }}
    >
      <header className="flex items-center gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {LANE_TITLES[lane]}
        </h2>
        <span className="text-xs text-muted-foreground">{cards.length}</span>
        {!droppable ? (
          <span
            className="ml-auto text-[10px] text-muted-foreground"
            title="Cards arrive here when an agent asks you something, and leave when you answer"
          >
            auto
          </span>
        ) : null}
      </header>

      {cards.length === 0 ? (
        <p className="px-1 pb-1 text-xs text-muted-foreground">
          {lane === "queue"
            ? "Nothing queued."
            : lane === "needs_you"
              ? "Nothing is waiting on you."
              : lane === "in_progress"
                ? "Nothing in flight."
                : lane === "in_review"
                  ? "Nothing waiting on your sign-off."
                  : "Nothing finished recently."}
        </p>
      ) : (
        cards.map((card) => (
          <BoardCardTile
            key={card.id}
            card={card}
            rpc={rpc}
            onRead={onRead}
            onArchive={onArchive}
            onDragStart={onDragStart}
          />
        ))
      )}
    </section>
  );
}

// ------------------------------------------------------------------- panel

function CommandCenter({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { items, board, isLoading, refresh } = useCommandCenter(rpc);
  const [projects, setProjects] = React.useState<{ id: string; name: string }[]>(
    [],
  );
  const [defaultProjectId, setDefaultProjectId] = React.useState<string | null>(
    null,
  );
  const [archived, setArchived] = React.useState<
    { cardId: string; archivedAt: number; title: string | null; taskKey: string | null }[]
  >([]);
  const [harnesses, setHarnesses] = React.useState<{
    list: Harness[];
    defaultProviderId: string | null;
    defaultModel: string | null;
  }>({ list: [], defaultProviderId: null, defaultModel: null });
  const [workflows, setWorkflows] = React.useState<
    { id: string; name: string; stepCount: number }[]
  >([]);
  const [voice, setVoice] = React.useState<VoiceAvailability>({
    enabled: false,
    error: null,
  });

  React.useEffect(() => {
    void rpc
      .call("projects")
      .then((result) => {
        setProjects(result.projects);
        setDefaultProjectId(result.defaultProjectId);
      })
      .catch(() => setProjects([]));
    void rpc
      .call("harnesses")
      .then((result) => {
        setHarnesses({
          list: result.harnesses,
          defaultProviderId: result.defaultProviderId,
          defaultModel: result.defaultModel,
        });
        if (result.error !== null) toast.error(result.error);
      })
      .catch(() =>
        setHarnesses({
          list: [],
          defaultProviderId: null,
          defaultModel: null,
        }),
      );
    void rpc
      .call("voiceStatus")
      .then(setVoice)
      .catch((error: unknown) =>
        setVoice({ enabled: false, error: String(error) }),
      );
    // Empty, not an error toast, when chief-nav is absent — a workflow is an
    // enhancement Chief applies, never something dispatch requires.
    void rpc
      .call("workflows")
      .then((result) => setWorkflows(result.workflows))
      .catch(() => setWorkflows([]));
  }, [rpc]);

  const openThread = React.useCallback(
    (threadId: string) => {
      navigate.toThread(threadId);
    },
    [navigate],
  );

  const isCompact = useIsCompactViewport();
  /** A drop that would dispatch to Chief waits here for confirmation. */
  const [pendingDispatch, setPendingDispatch] = React.useState<BoardCard | null>(
    null,
  );

  // The reading view owns a route, so a card is deep-linkable and browser back
  // returns to the board.
  const openViewer = React.useCallback(
    (cardId: string) => {
      navigate.toPluginPanel("inbox", { subPath: cardId });
    },
    [navigate],
  );

  const loadArchived = React.useCallback(async () => {
    try {
      const result = await rpc.call("archivedCards");
      setArchived(result.cards);
    } catch {
      setArchived([]);
    }
  }, [rpc]);

  React.useEffect(() => {
    void loadArchived();
  }, [loadArchived]);

  const archive = React.useCallback(
    async (cardId: string) => {
      try {
        const result = await rpc.call("archiveCard", { cardId });
        toastArchiveResult(result);
        await Promise.all([refresh(), loadArchived()]);
      } catch (error) {
        toast.error(String(error));
      }
    },
    [loadArchived, refresh, rpc],
  );

  const applyMove = React.useCallback(
    async (card: BoardCard, lane: BoardLane) => {
      try {
        const result = await rpc.call("moveCard", {
          cardId: card.id,
          lane,
        });
        if (!result.ok) {
          toast.error(result.error ?? "That move was refused.");
          return;
        }
        if (result.dispatchedTo !== null) toast.success("Dispatched");
        else if (result.error !== null) toast.warning(result.error);
        await refresh();
      } catch (error) {
        toast.error(String(error));
      }
    },
    [refresh, rpc],
  );

  const handleDrop = React.useCallback(
    (lane: BoardLane, cardId: string) => {
      const card = board.cards.find((entry) => entry.id === cardId);
      if (card === undefined || card.lane === lane) return;
      // Leaving Queue sends real work to Chief and cannot be taken back.
      if (lane === "in_progress" && card.dispatchOnAdvance) {
        setPendingDispatch(card);
        return;
      }
      void applyMove(card, lane);
    },
    [applyMove, board.cards],
  );

  // A card id in the route means "read this one" — the whole panel becomes the
  // document, rather than the board with something floating over it.
  const viewing = subPath.trim();
  if (viewing !== "") {
    return (
      <CardViewer
        cardId={viewing}
        rpc={rpc}
        voice={voice}
        onBack={() => navigate.toPluginPanel("inbox")}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 p-4 pb-2 md:p-5 md:pb-2">
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <Composer
            rpc={rpc}
            projects={projects}
            defaultProjectId={defaultProjectId}
            harnesses={harnesses}
            workflows={workflows}
            voice={voice}
            onAdded={refresh}
          />

          {board.chiefError !== null ? (
            <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
              {board.chiefError}
            </p>
          ) : null}

          {board.tasksError !== null ? (
            <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
              {board.tasksError}
            </p>
          ) : null}

          {!voice.enabled && voice.error !== null ? (
            <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
              {voice.error}
            </p>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 md:px-5 md:pb-5">
        {/* Centred on the same axis as the composer, just given more room —
            four lanes do not fit the composer's reading width. */}
        <div className="mx-auto w-full max-w-6xl">
        {isLoading && board.cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className={isCompact ? "space-y-3" : "flex gap-3"}>
            {LANES_ORDER.map((lane) => (
              <BoardColumn
                key={lane}
                lane={lane}
                cards={board.cards.filter((card) => card.lane === lane)}
                rpc={rpc}
                isCompact={isCompact}
                onRead={(card) => openViewer(card.id)}
                onArchive={(card) => void archive(card.id)}
                onDragStart={() => undefined}
                onDrop={handleDrop}
              />
            ))}
          </div>
        )}

        {archived.length > 0 ? (
          <details className="mt-4 border-t border-border pt-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Archived {archived.length}
            </summary>
            <div className="mt-2 space-y-1">
              {archived.map((entry) => (
                <div
                  key={entry.cardId}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5"
                >
                  {entry.taskKey !== null ? (
                    <Chip tone="accent">{entry.taskKey}</Chip>
                  ) : null}
                  <span className="min-w-0 truncate text-sm text-muted-foreground">
                    {entry.title ?? entry.cardId}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {relative(entry.archivedAt)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() =>
                      void rpc
                        .call("unarchiveCard", { cardId: entry.cardId })
                        .then(async (result) => {
                          toastUnarchiveResult(result);
                          await Promise.all([refresh(), loadArchived()]);
                        })
                        .catch((error: unknown) => toast.error(String(error)))
                    }
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {items.snoozed.length > 0 ? (
          <section className="mt-4 space-y-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Snoozed {items.snoozed.length}
            </h2>
            {items.snoozed.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <span className="truncate text-sm text-muted-foreground">
                  {item.question}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {item.snoozedUntil !== null
                    ? untilLabel(item.snoozedUntil)
                    : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void rpc.call("snooze", { id: item.id, untilMs: null })
                  }
                >
                  Wake
                </Button>
              </div>
            ))}
          </section>
        ) : null}
        </div>
      </div>

      <Dialog
        open={pendingDispatch !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDispatch(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Dispatch this now?</DialogTitle>
            <DialogDescription>
              It will start routing to a project owner straight away. That
              cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-foreground">{pendingDispatch?.title}</p>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPendingDispatch(null)}
            >
              Keep it queued
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const card = pendingDispatch;
                setPendingDispatch(null);
                if (card !== null) void applyMove(card, "in_progress");
              }}
            >
              Dispatch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CommandCenterHeader() {
  const rpc = useRpc<typeof rpcContract>();
  const { board } = useCommandCenter(rpc);
  const count = (lane: BoardLane) =>
    board.cards.filter((card) => card.lane === lane).length;
  const needsYou = count("needs_you");
  const queued = count("queue");
  const inFlight = count("in_progress");
  const parts = [
    needsYou > 0 ? `${needsYou} waiting on you` : null,
    queued > 0 ? `${queued} queued` : null,
    inFlight > 0 ? `${inFlight} in flight` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>
  );
}

// ------------------------------------------------------------------ chief
// Ported in when chief-nav merged back into this plugin: the org tree (Chief,
// project chiefs, task architects) as a rail beside a live agent chat.

interface ChiefState {
  chief: ChiefNavThread | null;
  chiefProjectId: string | null;
  groups: ChiefNavGroup[];
  needsInput: ChiefNavNeedsInput[];
  needsInputError: string | null;
}

const EMPTY_CHIEF_STATE: ChiefState = {
  chief: null,
  chiefProjectId: null,
  groups: [],
  needsInput: [],
  needsInputError: null,
};

/** Status dot. `active` is the only state that earns motion. */
function StatusDot({ status }: { status: ChiefNavThread["status"] }) {
  const tone =
    status === "active" || status === "starting"
      ? "bg-primary animate-pulse"
      : status === "error"
        ? "bg-destructive"
        : status === "stopping"
          ? "bg-muted-foreground"
          : "bg-muted-foreground/40";
  return (
    <span
      aria-hidden
      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${tone}`}
    />
  );
}

function RailRow({
  active,
  indent,
  onSelect,
  children,
}: {
  active: boolean;
  indent?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-2 rounded-md py-2.5 pr-2 text-left text-sm transition-colors md:py-1.5 ${
        indent ? "pl-6 md:pl-5" : "pl-2"
      } ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/50"
      }`}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/** Live match for a CSS media query — the rail behaves differently per width. */
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Whether a rail is shown, remembered per client like BB's own panes. */
function useRailPreference(key: string, fallback: boolean) {
  const storageKey = `bb-plugin-command-center:${key}`;
  const [isVisible, setVisible] = useState(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored === null ? fallback : stored !== "hidden";
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setVisible(next);
      try {
        window.localStorage.setItem(storageKey, next ? "visible" : "hidden");
      } catch {
        // Private mode or a blocked store — the preference just won't persist.
      }
    },
    [storageKey],
  );
  return [isVisible, set] as const;
}

function useChiefState() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<ChiefState>(EMPTY_CHIEF_STATE);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setState(await rpc.call("state"));
    setIsLoading(false);
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Plugin signals are ephemeral, so refetch on every change and whenever the
  // socket comes back — a missed signal must not leave a stale rail.
  useRealtime("state", () => void refresh());
  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);

  return { rpc, state, isLoading, refresh };
}

function ChiefPanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { rpc, state, isLoading, refresh } = useChiefState();
  const [isStarting, setIsStarting] = useState(false);

  // The rail hides at any width, but it hides differently. Wide: a column you
  // collapse, and the choice sticks. Phone: single-pane, so the rail is a
  // drawer over the chat that starts closed and closes on every selection.
  const isWide = useMediaQuery("(min-width: 768px)");
  const [isRailPinned, setRailPinned] = useRailPreference("rail-visible", true);
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const isRailShown = isWide ? isRailPinned : isDrawerOpen;
  const toggleRail = () =>
    isWide ? setRailPinned(!isRailPinned) : setDrawerOpen(!isDrawerOpen);

  // The open thread lives in the route, so a conversation is deep-linkable and
  // browser back walks the rail. Chief is the default.
  const selected = subPath || state.chief?.threadId || null;
  const select = (threadId: string) => {
    navigate.toPluginPanel("chief", { subPath: threadId });
    // Only a drawer is in the way of what you just opened; a pinned column
    // stays put.
    setDrawerOpen(false);
  };

  useEffect(() => {
    if (isWide || !isDrawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isWide, isDrawerOpen]);

  const allThreads: { entry: ChiefNavThread; role: string; project?: string }[] =
    [
      ...(state.chief ? [{ entry: state.chief, role: "Chief" }] : []),
      ...state.groups.flatMap((group) => [
        {
          entry: group.chief,
          role: "Project chief",
          project: group.projectName,
        },
        ...group.architects.map((architect) => ({
          entry: architect,
          role: "Task architect",
          project: group.projectName,
        })),
      ]),
    ];
  const open = allThreads.find((item) => item.entry.threadId === selected);
  const isChiefOpen = Boolean(state.chief && selected === state.chief.threadId);

  const startChief = async () => {
    setIsStarting(true);
    try {
      const result = await rpc.call("ensureChief");
      await refresh();
      select(result.threadId);
      if (result.created) toast.success("Chief is booting up");
    } catch (error) {
      toast.error(`Could not start Chief: ${String(error)}`);
    } finally {
      setIsStarting(false);
    }
  };

  const setRetired = async (threadId: string, retired: boolean) => {
    await rpc.call("setRetired", { threadId, retired });
    await refresh();
  };

  const openLabel = open
    ? `${open.entry.taskKey ? `${open.entry.taskKey} — ` : ""}${open.entry.title}`
    : "Chief";

  return (
    <div className="relative flex h-full min-h-0 w-full">
      {/* Scrim: only ever present while a phone drawer is over the chat. */}
      {!isWide && isDrawerOpen ? (
        <button
          type="button"
          aria-label="Close the list"
          onClick={() => setDrawerOpen(false)}
          className="absolute inset-0 z-10 bg-background/60"
        />
      ) : null}

      <aside
        className={`z-20 min-w-0 flex-col overflow-y-auto border-border bg-background p-2 ${
          isRailShown ? "flex" : "hidden"
        } ${
          isWide
            ? "static w-64 shrink-0 border-r"
            : "absolute inset-y-0 left-0 w-[17rem] max-w-[85%] border-r shadow-lg"
        }`}
      >
        {state.chief ? (
          <RailRow
            active={isChiefOpen}
            onSelect={() => select(state.chief!.threadId)}
          >
            <StatusDot status={state.chief.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">Chief</span>
              <span className="block truncate text-xs text-muted-foreground">
                Your only conversation
              </span>
            </span>
          </RailRow>
        ) : (
          <Button
            size="sm"
            className="w-full"
            disabled={isStarting || isLoading}
            onClick={() => void startChief()}
          >
            {isStarting ? "Starting…" : "Start Chief"}
          </Button>
        )}

        <SectionLabel>
          Project chiefs
          {state.groups.length > 0 ? ` (${state.groups.length})` : ""}
        </SectionLabel>
        {state.groups.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">
            None yet. Ask Chief to stand one up for a project — Chief creates and
            manages them.
          </p>
        ) : (
          state.groups.map((group) => (
            <div key={group.projectId}>
              <RailRow
                active={selected === group.chief.threadId}
                onSelect={() => select(group.chief.threadId)}
              >
                <StatusDot status={group.chief.status} />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate ${
                      group.chief.retired ? "text-muted-foreground" : ""
                    }`}
                  >
                    {group.chief.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {group.chief.subtitle ?? group.projectName}
                  </span>
                </span>
              </RailRow>
              {group.architects.map((architect) => (
                <RailRow
                  key={architect.threadId}
                  indent
                  active={selected === architect.threadId}
                  onSelect={() => select(architect.threadId)}
                >
                  <StatusDot status={architect.status} />
                  <span
                    className={`min-w-0 flex-1 truncate text-xs ${
                      architect.retired
                        ? "text-muted-foreground/70"
                        : "text-muted-foreground"
                    }`}
                  >
                    {architect.taskKey ? (
                      <span className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-foreground">
                        {architect.taskKey}
                      </span>
                    ) : null}
                    {architect.title}
                  </span>
                </RailRow>
              ))}
            </div>
          ))
        )}

        {state.needsInput.length > 0 ? (
          <>
            <SectionLabel>Needs you ({state.needsInput.length})</SectionLabel>
            {state.needsInput.map((item) => {
              const target = item.reviewThreadId ?? item.askerThreadId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (target) select(target);
                    else toast.info("Answer this one in the Inbox panel.");
                  }}
                  className={`mt-1 w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                    item.urgent
                      ? "border-destructive/50 bg-destructive/5"
                      : "border-border bg-card"
                  } hover:bg-accent/50`}
                >
                  <span className="block truncate font-medium text-foreground">
                    {item.taskKey ?? item.task}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-muted-foreground">
                    {item.question}
                  </span>
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    {target ? "Open the thread to review" : "Answer in Inbox"}
                  </span>
                </button>
              );
            })}
          </>
        ) : null}

        {state.needsInputError ? (
          <p className="mt-3 px-2 text-[11px] text-muted-foreground">
            Inbox unavailable — install the Inbox plugin to see what is waiting
            on you.
          </p>
        ) : null}
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            aria-label={isRailShown ? "Hide Chief's org" : "Show Chief's org"}
            aria-expanded={isRailShown}
            onClick={toggleRail}
          >
            <span aria-hidden className="text-base leading-none">
              {isRailShown ? "⟨" : "☰"}
            </span>
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-medium text-foreground">{openLabel}</span>
            {open && !isChiefOpen ? (
              <span className="ml-2 hidden text-xs text-muted-foreground md:inline">
                {open.role}
                {open.project ? ` · ${open.project}` : ""} · reports upward, not
                to you
              </span>
            ) : null}
          </span>
          {open && !isChiefOpen ? (
            <div className="flex shrink-0 gap-1">
              {state.chief ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="hidden md:inline-flex"
                  onClick={() => select(state.chief!.threadId)}
                >
                  Back to Chief
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void setRetired(open.entry.threadId, !open.entry.retired)
                }
              >
                {open.entry.retired ? "Restore" : "Retire"}
              </Button>
            </div>
          ) : null}
        </div>

        {selected ? (
          <ThreadChat
            key={selected}
            threadId={selected}
            variant="full"
            layout="contained"
            className="min-h-0 flex-1"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 md:p-8">
            <div className="max-w-sm text-center">
              <p className="text-sm font-medium text-foreground">
                Chief isn't running yet
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Start Chief and talk only to Chief. It stands up a chief per
                project, and those chiefs create the tasks and brief the
                architects that do the work.
              </p>
              <Button
                size="sm"
                className="mt-4"
                disabled={isStarting || isLoading}
                onClick={() => void startChief()}
              >
                {isStarting ? "Starting…" : "Start Chief"}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The Chief panel's header summary. It answers three questions in order: is
 * Chief alive and how many of its threads are mid-turn. Unfinished work
 * belongs to the command center board, which counts it in its own header.
 */
function ChiefHeader() {
  const { state } = useChiefState();

  const isChiefWorking =
    state.chief?.status === "active" || state.chief?.status === "starting";
  const working = state.groups
    .flatMap((group) => [group.chief, ...group.architects])
    .filter(
      (entry) =>
        !entry.retired &&
        (entry.status === "active" || entry.status === "starting"),
    ).length;

  const parts: string[] = [
    !state.chief
      ? "Chief not started"
      : isChiefWorking
        ? "Chief working"
        : "Chief idle",
  ];
  if (working > 0) {
    parts.push(`${working} agent${working === 1 ? "" : "s"} working`);
  }
  if (state.needsInput.length > 0) {
    parts.push(`${state.needsInput.length} waiting on you`);
  }

  return (
    <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>
  );
}

export default definePluginApp((app) => {
  // A badge on our own sidebar row. There is no slot for this, so it is page
  // code; it runs while any bb window is open, not only while this panel is.
  app.contentScripts.register({
    id: "nav-badge",
    mount: ({ signal }) => mountNavBadge({ signal }),
  });

  app.slots.navPanel({
    id: "inbox",
    title: "Command Center",
    icon: "Mail",
    path: "inbox",
    component: CommandCenter,
    headerContent: CommandCenterHeader,
  });

  app.slots.navPanel({
    id: "chief",
    title: "Chief",
    icon: "Crown",
    path: "chief",
    component: ChiefPanel,
    headerContent: ChiefHeader,
  });
});

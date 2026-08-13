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
import {
  Markdown,
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
import { ChiefHeader, ChiefPanel } from "./chief/panel";
import { mountNavBadge } from "./nav-badge";
import type {
  BoardCard,
  BoardLane,
  InboxItem,
  InboxRequest,
  rpcContract,
} from "./server";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Priority = InboxRequest["priority"];
type VoiceCapture = ReturnType<typeof useVoiceCapture>;

const PRIORITIES: Priority[] = ["low", "normal", "high"];

interface VoiceAvailability {
  enabled: boolean;
  error: string | null;
}

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

/**
 * The one control for every voice affordance: idle mic, live stop button, and
 * a spinner while the clip is being transcribed.
 */
function MicButton({
  capture,
  availability,
  label,
}: {
  capture: VoiceCapture;
  availability: VoiceAvailability;
  label: string;
}) {
  if (!capture.isSupported || !availability.enabled) return null;

  const { isRecording, isTranscribing, toggle } = capture;
  return (
    <Button
      size="sm"
      variant={isRecording ? "destructive" : "ghost"}
      disabled={isTranscribing}
      aria-label={isRecording ? `Stop recording (${label})` : label}
      aria-pressed={isRecording}
      onClick={() => toggle()}
    >
      <Icon
        name={isTranscribing ? "Spinner" : isRecording ? "Square" : "Mic"}
        className={isTranscribing ? "animate-spin" : undefined}
        aria-hidden="true"
      />
      {isRecording ? "Stop" : null}
    </Button>
  );
}

/** What the transcriber heard, so a mishearing is visible before it acts. */
function HeardLine({
  transcript,
  understood,
  hint,
}: {
  transcript: string;
  understood?: string[];
  hint?: string;
}) {
  return (
    <div className="space-y-1 rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
      <p className="text-xs italic text-muted-foreground">“{transcript}”</p>
      {understood !== undefined && understood.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {understood.map((entry) => (
            <Chip key={entry} tone="accent">
              {entry}
            </Chip>
          ))}
        </div>
      ) : null}
      {hint !== undefined ? (
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * A comment body as bb renders chat messages — agents write real Markdown
 * (headings, tables, code fences), and a 10,000-character plan shown as
 * pre-wrapped text is unreadable, worse so on a phone.
 *
 * Long bodies collapse by default so a card with five comments stays scannable
 * and you expand only the one you came for.
 */
function CommentBody({ body }: { body: string }) {
  const isLong = body.length > 700 || body.split("\n").length > 12;
  const [isExpanded, setExpanded] = React.useState(false);
  const isCollapsed = isLong && !isExpanded;

  return (
    <div className="min-w-0 space-y-1">
      <div
        className={
          isCollapsed ? "relative max-h-40 overflow-hidden" : undefined
        }
      >
        {/* Wide tables and code fences scroll rather than stretch the card. */}
        <div className="min-w-0 overflow-x-auto">
          <Markdown content={body} />
        </div>
        {isCollapsed ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent" />
        ) : null}
      </div>
      {isLong ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setExpanded((current) => !current)}
        >
          {isExpanded
            ? "Show less"
            : `Show more · ${Math.max(1, Math.round(body.length / 1000))}k chars`}
        </Button>
      ) : null}
    </div>
  );
}

function relative(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function untilLabel(ms: number): string {
  const minutes = Math.round((ms - Date.now()) / 60_000);
  if (minutes <= 0) return "due";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
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

function Chip({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "urgent" | "accent";
}) {
  const toneClass =
    tone === "urgent"
      ? "border-destructive/40 text-destructive"
      : tone === "accent"
        ? "border-border text-foreground"
        : "border-border text-muted-foreground";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] leading-none ${toneClass}`}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- composer

function Composer({
  rpc,
  projects,
  voice,
  onAdded,
}: {
  rpc: Rpc;
  projects: { id: string; name: string }[];
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
      });
      if (dispatchNow) {
        const result = await rpc.call("dispatchRequest", { id });
        if (result.ok) toast.success("Dispatched to Chief");
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
          placeholder="Context, constraints, links — anything Chief should route with."
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
          <option value="">Let Chief pick the project</option>
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

function ItemCard({
  item,
  rpc,
  voice,
  onNavigate,
}: {
  item: InboxItem;
  rpc: Rpc;
  voice: VoiceAvailability;
  onNavigate: (threadId: string) => void;
}) {
  const [text, setText] = React.useState("");
  const [checked, setChecked] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [heard, setHeard] = React.useState<{
    transcript: string;
    hint: string;
  } | null>(null);
  /** A spoken option waits for one confirming tap rather than self-sending. */
  const [pendingOption, setPendingOption] = React.useState<string | null>(null);

  const hasOptions = item.options.length > 0;
  const takesText =
    item.kind === "text" || item.kind === "review" || !hasOptions;

  const capture = useVoiceCapture({
    onClip: async (clip) => {
      const result = await rpc.call("voiceAnswer", {
        audioBase64: clip.base64,
        mimeType: clip.mimeType,
        filename: clip.filename,
        itemId: item.id,
      });

      if (item.kind === "multi" && result.options.length > 0) {
        setChecked(result.options);
        setHeard({
          transcript: result.transcript,
          hint: `Selected ${result.options.length}. Press Send to confirm.`,
        });
        return;
      }
      if (hasOptions && result.option !== null) {
        setPendingOption(result.option);
        setHeard({
          transcript: result.transcript,
          hint: `Matched “${result.option}” — press it to confirm.`,
        });
        return;
      }
      if (takesText) {
        setText(result.transcript);
        setHeard({
          transcript: result.transcript,
          hint: "Press Send to answer.",
        });
        return;
      }
      setHeard({
        transcript: result.transcript,
        hint: "That did not match any option — pick one below.",
      });
    },
    onError: (message) => toast.error(message),
  });

  const resolve = async (answer: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.call("answer", { id: item.id, answer });
      toast.success("Answered");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const snooze = async (hours: number) => {
    try {
      await rpc.call("snooze", {
        id: item.id,
        untilMs: Date.now() + hours * 3_600_000,
      });
    } catch (error) {
      toast.error(String(error));
    }
  };

  return (
    <article className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {item.urgent ? <Chip tone="urgent">urgent</Chip> : null}
        {item.task !== "" ? <Chip tone="accent">{item.task}</Chip> : null}
        {item.taskKey !== null ? <Chip>{item.taskKey}</Chip> : null}
        {item.askedBy !== null ? <Chip>{item.askedBy}</Chip> : null}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {relative(item.createdAt)}
        </span>
        <MicButton
          capture={capture}
          availability={voice}
          label="Answer by voice"
        />
      </div>

      <p className="text-sm text-foreground">{item.question}</p>

      {heard !== null ? (
        <HeardLine transcript={heard.transcript} hint={heard.hint} />
      ) : null}

      {item.priorAnswer !== null ? (
        <p className="text-xs text-destructive">
          Withdrawn answer: {item.priorAnswer}
        </p>
      ) : null}

      {item.reviewThreadId !== null || item.reviewUrl !== null ? (
        <div className="flex gap-2">
          {item.reviewThreadId !== null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onNavigate(item.reviewThreadId!)}
            >
              Open thread
            </Button>
          ) : null}
          {item.reviewUrl !== null ? (
            <Button size="sm" variant="outline" asChild>
              <a href={item.reviewUrl} target="_blank" rel="noreferrer">
                Open link
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.kind === "options" || item.kind === "review" ? (
        <div className="flex flex-wrap gap-2">
          {item.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={pendingOption === option ? "default" : "outline"}
              className={
                pendingOption === option ? "ring-2 ring-ring" : undefined
              }
              disabled={busy}
              onClick={() => void resolve(option)}
            >
              {option}
            </Button>
          ))}
          {item.kind === "review" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void resolve("Reviewed, no comments.")}
            >
              Reviewed
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.kind === "multi" ? (
        <div className="space-y-1">
          {item.options.map((option) => (
            <label
              key={option}
              className="flex items-center gap-2 text-sm text-foreground"
            >
              <input
                type="checkbox"
                checked={checked.includes(option)}
                onChange={(event) =>
                  setChecked((current) =>
                    event.target.checked
                      ? [...current, option]
                      : current.filter((entry) => entry !== option),
                  )
                }
              />
              {option}
            </label>
          ))}
          <Button
            size="sm"
            disabled={busy || checked.length === 0}
            onClick={() => void resolve(checked.join(", "))}
          >
            Send {checked.length > 0 ? `(${checked.length})` : ""}
          </Button>
        </div>
      ) : null}

      {item.kind === "text" || item.kind === "review" ? (
        <div className="flex gap-2">
          <Input
            value={text}
            placeholder={item.placeholder ?? "Your answer"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && text.trim() !== "") {
                event.preventDefault();
                void resolve(text.trim());
              }
            }}
          />
          <Button
            size="sm"
            disabled={busy || text.trim() === ""}
            onClick={() => void resolve(text.trim())}
          >
            Send
          </Button>
        </div>
      ) : null}

      {item.kind === "ack" ? (
        <Button size="sm" disabled={busy} onClick={() => void resolve("Acknowledged.")}>
          Got it
        </Button>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={() => void snooze(1)}>
          Snooze 1h
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void snooze(4)}>
          4h
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void rpc.call("dismiss", { id: item.id })}
        >
          Dismiss
        </Button>
        {item.threadId !== null ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => onNavigate(item.threadId!)}
          >
            Who asked
          </Button>
        ) : null}
      </div>
    </article>
  );
}

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
    case "active":
    case "starting":
      return "text-foreground";
    case "error":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

/** Comments and context for one card, including answering its question. */
function CardDetail({
  card,
  rpc,
  voice,
  onClose,
  onNavigate,
  onMove,
}: {
  card: BoardCard;
  rpc: Rpc;
  voice: VoiceAvailability;
  onClose: () => void;
  onNavigate: (threadId: string) => void;
  onMove: (card: BoardCard, lane: BoardLane) => void;
}) {
  const [comments, setComments] = React.useState<
    {
      id: string;
      body: string;
      authorName: string;
      kind: string;
      threadId: string | null;
      threadTitle: string | null;
      createdAt: string;
      notifiedCount: number;
      pending: boolean;
    }[]
  >([]);
  const [canNotify, setCanNotify] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const result = await rpc.call("cardComments", { cardId: card.id });
      setComments(result.comments);
      setCanNotify(result.canNotify);
      if (result.error !== null) toast.error(result.error);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoaded(true);
    }
  }, [card.id, rpc]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    const body = draft.trim();
    if (body === "" || busy) return;
    setBusy(true);
    try {
      const result = await rpc.call("addCardComment", {
        cardId: card.id,
        body,
      });
      if (!result.ok) {
        toast.error(result.error ?? "Comment failed");
        return;
      }
      setDraft("");
      toast.success(
        result.pending
          ? "Saved — it reaches the worker once Chief creates the task."
          : result.notified > 0
            ? `Sent to ${result.notified} working thread${result.notified === 1 ? "" : "s"}.`
            : "Added to the task.",
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="min-h-0 max-w-3xl">
      <DialogHeader>
        <DialogTitle>{card.title}</DialogTitle>
        <DialogDescription>
          {[
            card.taskKey,
            card.projectName,
            card.taskStatus,
            LANE_TITLES[card.lane],
          ]
            .filter((part): part is string => part !== null && part !== "")
            .join(" · ")}
        </DialogDescription>
      </DialogHeader>

      <div className="min-w-0 space-y-4 md:max-h-[70vh] md:overflow-y-auto">
        {card.body.trim() !== "" ? (
          <CommentBody body={card.body} />
        ) : null}

        {card.outcome !== null ? (
          <section className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Outcome
            </h3>
            <CommentBody body={card.outcome} />
          </section>
        ) : null}

        {card.question !== null ? (
          <ItemCard
            item={card.question}
            rpc={rpc}
            voice={voice}
            onNavigate={onNavigate}
          />
        ) : null}

        {card.workers.length > 0 ? (
          <section className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Working on it
            </h3>
            {card.workers.map((worker) => (
              <button
                key={worker.threadId}
                type="button"
                className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left hover:bg-state-hover"
                onClick={() => onNavigate(worker.threadId)}
              >
                <span className="truncate text-sm text-foreground">
                  {worker.title ?? worker.threadId}
                </span>
                <span
                  className={`ml-auto shrink-0 text-[10px] ${workerTone(worker.liveStatus)}`}
                >
                  {worker.liveStatus ?? "idle"}
                </span>
              </button>
            ))}
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Comments
          </h3>

          <div className="flex gap-2">
            <Input
              autoFocus
              value={draft}
              placeholder={
                canNotify
                  ? "Add context — the worker gets it immediately"
                  : "Add context — delivered once this has a task"
              }
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <Button
              size="sm"
              disabled={busy || draft.trim() === ""}
              onClick={() => void submit()}
            >
              Send
            </Button>
          </div>

          {!loaded ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No comments yet. Anything you add here reaches whoever is working
              this.
            </p>
          ) : (
            <div className="space-y-2">
              {comments.map((comment) => (
                <article
                  key={comment.id}
                  className="space-y-1 rounded-md border border-border px-2 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs font-medium text-foreground">
                      {comment.authorName}
                    </span>
                    {comment.threadTitle !== null ? (
                      <Chip>{comment.threadTitle}</Chip>
                    ) : null}
                    {comment.pending ? <Chip tone="urgent">pending</Chip> : null}
                    {comment.notifiedCount > 0 ? (
                      <Chip>sent to {comment.notifiedCount}</Chip>
                    ) : null}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {relative(Date.parse(comment.createdAt))}
                    </span>
                  </div>
                  <CommentBody body={comment.body} />
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <DialogFooter>
        <div className="mr-auto flex flex-wrap gap-1">
          {card.movable
            ? DROPPABLE_LANES.filter((lane) => lane !== card.lane).map((lane) => (
                <Button
                  key={lane}
                  size="sm"
                  variant="outline"
                  onClick={() => onMove(card, lane)}
                >
                  → {LANE_TITLES[lane]}
                </Button>
              ))
            : null}
        </div>
        {card.chiefThreadId !== null ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onNavigate(card.chiefThreadId!)}
          >
            Open Chief
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function BoardCardTile({
  card,
  rpc,
  onOpen,
  onDragStart,
}: {
  card: BoardCard;
  rpc: Rpc;
  onOpen: (card: BoardCard) => void;
  onDragStart: (card: BoardCard) => void;
}) {
  const question = card.question;
  return (
    <article
      draggable={card.movable}
      onDragStart={(event) => {
        if (!card.movable) return;
        event.dataTransfer.setData(DRAG_MIME, card.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(card);
      }}
      className={`space-y-1.5 rounded-lg border bg-card p-2.5 ${
        card.movable ? "cursor-grab active:cursor-grabbing" : ""
      } ${card.urgent ? "border-destructive/50" : "border-border"} hover:border-ring`}
    >
      <button
        type="button"
        className="w-full text-left"
        onClick={() => onOpen(card)}
      >
        <p className="line-clamp-3 text-sm text-foreground">{card.title}</p>
      </button>

      <div className="flex flex-wrap items-center gap-1">
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
      </div>

      {question !== null ? (
        <div className="space-y-1.5 border-t border-border/60 pt-1.5">
          <p className="line-clamp-4 text-xs text-muted-foreground">
            {question.question}
          </p>
          <div className="flex flex-wrap gap-1">
            {question.options.slice(0, 3).map((option) => (
              <Button
                key={option}
                size="sm"
                variant="outline"
                onClick={() =>
                  void rpc
                    .call("answer", { id: question.id, answer: option })
                    .then(() => toast.success("Answered"))
                    .catch((error: unknown) => toast.error(String(error)))
                }
              >
                {option}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => onOpen(card)}>
              {question.options.length > 3 ? "More…" : "Answer…"}
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
  onOpen,
  onDragStart,
  onDrop,
}: {
  lane: BoardLane;
  cards: BoardCard[];
  rpc: Rpc;
  isCompact: boolean;
  onOpen: (card: BoardCard) => void;
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
            onOpen={onOpen}
            onDragStart={onDragStart}
          />
        ))
      )}
    </section>
  );
}

// ------------------------------------------------------------------- panel

function CommandCenter() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { items, board, isLoading, refresh } = useCommandCenter(rpc);
  const [projects, setProjects] = React.useState<{ id: string; name: string }[]>(
    [],
  );
  const [voice, setVoice] = React.useState<VoiceAvailability>({
    enabled: false,
    error: null,
  });

  React.useEffect(() => {
    void rpc
      .call("projects")
      .then((result) => setProjects(result.projects))
      .catch(() => setProjects([]));
    void rpc
      .call("voiceStatus")
      .then(setVoice)
      .catch((error: unknown) =>
        setVoice({ enabled: false, error: String(error) }),
      );
  }, [rpc]);

  const openThread = React.useCallback(
    (threadId: string) => {
      navigate.toThread(threadId);
    },
    [navigate],
  );

  const isCompact = useIsCompactViewport();
  const [openCardId, setOpenCardId] = React.useState<string | null>(null);
  /** A drop that would dispatch to Chief waits here for confirmation. */
  const [pendingDispatch, setPendingDispatch] = React.useState<BoardCard | null>(
    null,
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
        if (result.dispatchedTo !== null) toast.success("Dispatched to Chief");
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

  const openCard =
    openCardId === null
      ? null
      : board.cards.find((card) => card.id === openCardId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 p-4 pb-2 md:p-5 md:pb-2">
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <Composer
            rpc={rpc}
            projects={projects}
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
                onOpen={(card) => setOpenCardId(card.id)}
                onDragStart={() => undefined}
                onDrop={handleDrop}
              />
            ))}
          </div>
        )}

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
        open={openCard !== null}
        onOpenChange={(open) => {
          if (!open) setOpenCardId(null);
        }}
      >
        {openCard !== null ? (
          <CardDetail
            card={openCard}
            rpc={rpc}
            voice={voice}
            onClose={() => setOpenCardId(null)}
            onNavigate={openThread}
            onMove={(card, lane) => {
              setOpenCardId(null);
              if (lane === "in_progress" && card.dispatchOnAdvance) {
                setPendingDispatch(card);
                return;
              }
              void applyMove(card, lane);
            }}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={pendingDispatch !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDispatch(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send this to Chief?</DialogTitle>
            <DialogDescription>
              Chief will start routing it to a project chief straight away. That
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
  // Chief's org map keeps its own entry: the board is the work, this is who is
  // working it. One plugin, two jobs.
  app.slots.navPanel({
    id: "chief",
    title: "Chief",
    icon: "Crown",
    path: "chief",
    component: ChiefPanel,
    headerContent: ChiefHeader,
  });
});

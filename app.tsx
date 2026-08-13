/**
 * The command center panel.
 *
 * Top: a composer that queues a request in one keystroke.
 * Then three lanes: questions waiting on you, the request queue you dispatch
 * to Chief, and what is currently in flight beneath it.
 */
import * as React from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useVoiceCapture } from "@/hooks/useVoiceCapture";
import type { InboxItem, InboxRequest, rpcContract } from "./server";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Priority = InboxRequest["priority"];
type VoiceCapture = ReturnType<typeof useVoiceCapture>;

const PRIORITIES: Priority[] = ["low", "normal", "high"];

interface VoiceAvailability {
  enabled: boolean;
  error: string | null;
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

/** One shared read of both lanes, refetched whenever the backend signals. */
function useCommandCenter(rpc: Rpc) {
  const [items, setItems] = React.useState<{
    open: InboxItem[];
    snoozed: InboxItem[];
    resolved: InboxItem[];
  }>({ open: [], snoozed: [], resolved: [] });
  const [queue, setQueue] = React.useState<{
    requests: InboxRequest[];
    chiefThreadId: string | null;
    chiefStatus: string | null;
    chiefError: string | null;
  }>({
    requests: [],
    chiefThreadId: null,
    chiefStatus: null,
    chiefError: null,
  });
  const [isLoading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const [nextItems, nextQueue] = await Promise.all([
        rpc.call("list"),
        rpc.call("queue"),
      ]);
      setItems(nextItems);
      setQueue(nextQueue);
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

  return { items, queue, isLoading, refresh };
}

// ------------------------------------------------------------------ chrome

function Lane({
  title,
  count,
  children,
  action,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <header className="flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        <span className="text-xs text-muted-foreground">{count}</span>
        <div className="ml-auto">{action}</div>
      </header>
      {children}
    </section>
  );
}

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

  // Push to talk from anywhere in the panel, including while typing.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.code !== "KeyV" || event.repeat) return;
      event.preventDefault();
      capture.toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capture]);

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
            void submit(event.metaKey || event.ctrlKey);
          }}
        />
        <MicButton
          capture={capture}
          availability={voice}
          label="Dictate a request (⌥V)"
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
          value={body}
          placeholder="Context, constraints, links — anything Chief should route with."
          rows={3}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) => setBody(event.target.value)}
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
          onClick={() => setShowBody((current) => !current)}
        >
          {showBody ? "Hide detail" : "Add detail"}
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

// ---------------------------------------------------------------- requests

function RequestRow({
  request,
  rpc,
  onNavigate,
}: {
  request: InboxRequest;
  rpc: Rpc;
  onNavigate: (threadId: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const isQueued = request.state === "queued";
  const isClosed = request.state === "done" || request.state === "cancelled";

  const dispatch = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("dispatchRequest", { id: request.id });
      if (result.ok) toast.success("Dispatched to Chief");
      else toast.error(result.error ?? "Dispatch failed");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="space-y-1.5 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {request.urgent ? <Chip tone="urgent">urgent</Chip> : null}
        {request.priority !== "normal" ? <Chip>{request.priority}</Chip> : null}
        {!isQueued ? <Chip tone="accent">{request.state}</Chip> : null}
        {request.taskKey !== null ? <Chip tone="accent">{request.taskKey}</Chip> : null}
        {request.blockedBy !== null ? <Chip tone="urgent">blocked</Chip> : null}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {relative(request.createdAt)}
        </span>
      </div>

      <p
        className={`text-sm ${isClosed ? "text-muted-foreground line-through" : "text-foreground"}`}
      >
        {request.title}
      </p>
      {request.body.trim() !== "" ? (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
          {request.body}
        </p>
      ) : null}
      {request.outcome !== null ? (
        <p className="text-xs text-muted-foreground">{request.outcome}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        {isQueued ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Move up"
              onClick={() =>
                void rpc.call("moveRequest", { id: request.id, direction: "up" })
              }
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Move down"
              onClick={() =>
                void rpc.call("moveRequest", {
                  id: request.id,
                  direction: "down",
                })
              }
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void rpc.call("moveRequest", {
                  id: request.id,
                  direction: "top",
                })
              }
            >
              Top
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void dispatch()}>
              Dispatch
            </Button>
          </>
        ) : null}

        {request.chiefThreadId !== null ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate(request.chiefThreadId!)}
          >
            Open Chief
          </Button>
        ) : null}

        {!isClosed ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() =>
              void rpc.call("closeRequest", {
                id: request.id,
                cancelled: true,
                outcome: null,
              })
            }
          >
            {isQueued ? "Delete" : "Cancel"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void rpc.call("reopenRequest", { id: request.id })}
          >
            Requeue
          </Button>
        )}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------- panel

function CommandCenter() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { items, queue, isLoading, refresh } = useCommandCenter(rpc);
  const [projects, setProjects] = React.useState<{ id: string; name: string }[]>(
    [],
  );
  const [showDone, setShowDone] = React.useState(false);
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

  const queued = queue.requests.filter((request) => request.state === "queued");
  const inFlight = queue.requests.filter(
    (request) => request.state === "dispatched" || request.state === "in_flight",
  );
  const closed = queue.requests.filter(
    (request) => request.state === "done" || request.state === "cancelled",
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 p-4 md:p-5">
        <Composer
          rpc={rpc}
          projects={projects}
          voice={voice}
          onAdded={refresh}
        />

        {queue.chiefError !== null ? (
          <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {queue.chiefError}
          </p>
        ) : null}

        {!voice.enabled && voice.error !== null ? (
          <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            {voice.error}
          </p>
        ) : null}

        <Lane title="Needs you" count={items.open.length}>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : items.open.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is waiting on you.
            </p>
          ) : (
            <div className="space-y-2">
              {items.open.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  rpc={rpc}
                  voice={voice}
                  onNavigate={openThread}
                />
              ))}
            </div>
          )}
        </Lane>

        <Lane title="Queue" count={queued.length}>
          {queued.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing queued. Type above to add work.
            </p>
          ) : (
            <div className="space-y-2">
              {queued.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  rpc={rpc}
                  onNavigate={openThread}
                />
              ))}
            </div>
          )}
        </Lane>

        {inFlight.length > 0 ? (
          <Lane title="In flight" count={inFlight.length}>
            <div className="space-y-2">
              {inFlight.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  rpc={rpc}
                  onNavigate={openThread}
                />
              ))}
            </div>
          </Lane>
        ) : null}

        {items.snoozed.length > 0 ? (
          <Lane title="Snoozed" count={items.snoozed.length}>
            <div className="space-y-1">
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
            </div>
          </Lane>
        ) : null}

        <Lane
          title="Done"
          count={closed.length}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowDone((current) => !current)}
            >
              {showDone ? "Hide" : "Show"}
            </Button>
          }
        >
          {showDone ? (
            <div className="space-y-2">
              {closed.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  rpc={rpc}
                  onNavigate={openThread}
                />
              ))}
              {items.resolved.slice(0, 20).map((item) => (
                <div
                  key={item.id}
                  className="space-y-1 rounded-md border border-border px-3 py-2"
                >
                  <p className="text-xs text-muted-foreground">
                    {item.question}
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm text-foreground">
                      {item.answer ?? "(dismissed)"}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto shrink-0"
                      aria-label="Take this answer back"
                      onClick={() => void rpc.call("retract", { id: item.id })}
                    >
                      Retract
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </Lane>
      </div>
    </div>
  );
}

function CommandCenterHeader() {
  const rpc = useRpc<typeof rpcContract>();
  const { items, queue } = useCommandCenter(rpc);
  const queued = queue.requests.filter(
    (request) => request.state === "queued",
  ).length;
  const inFlight = queue.requests.filter(
    (request) => request.state === "dispatched" || request.state === "in_flight",
  ).length;
  const parts = [
    items.open.length > 0 ? `${items.open.length} waiting on you` : null,
    queued > 0 ? `${queued} queued` : null,
    inFlight > 0 ? `${inFlight} in flight` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Mail",
    path: "inbox",
    component: CommandCenter,
    headerContent: CommandCenterHeader,
  });
});

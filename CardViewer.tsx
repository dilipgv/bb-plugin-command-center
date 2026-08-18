/**
 * The reading view for one card.
 *
 * The board is for scanning; this is for reading. Agents write research
 * summaries thousands of words long, in real Markdown, and a 206px lane or a
 * modal is the wrong shape for that. This is a document: one comfortable measure,
 * the artifacts you asked for at the top, and every summary expanded — you came
 * here to read, so nothing is folded away.
 *
 * It owns a route (`…/inbox/<cardId>`), so it is deep-linkable, browser-back
 * works, and on a phone it is a page rather than a cramped drawer.
 */
import * as React from "react";
import { Markdown, useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  QuestionCard,
  toastArchiveResult,
  type VoiceAvailability,
} from "./card-parts";
import { previewMarkdown } from "./lib/markdown-preview";
import type { BoardCard, BoardLane, rpcContract } from "./server";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

interface Artifact {
  kind: "pull-request" | "confluence" | "jira" | "link";
  url: string;
  label: string;
}

interface Comment {
  id: string;
  body: string;
  authorName: string;
  kind: "user" | "agent" | "system";
  threadId: string | null;
  threadTitle: string | null;
  createdAt: string;
  notifiedCount: number;
  pending: boolean;
}

const LANE_LABEL: Record<BoardLane, string> = {
  queue: "Queue",
  in_progress: "In progress",
  in_review: "In review",
  needs_you: "Needs you",
  done: "Done",
};

const ARTIFACT_ICON: Record<Artifact["kind"], IconName> = {
  "pull-request": "GitPullRequest",
  confluence: "FileText",
  jira: "CircleCheck",
  link: "ExternalLink",
};

function when(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Stop a worker. Two-step on purpose: stopping discards whatever the agent was
 * part-way through, and this button sits beside a navigation control.
 */
function StopWorker({
  threadId,
  isRunning,
  rpc,
  onStopped,
}: {
  threadId: string;
  isRunning: boolean;
  rpc: Rpc;
  onStopped: () => void;
}) {
  const [armed, setArmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!armed) return;
    // Forget the intent if it is not confirmed promptly.
    const timer = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (!isRunning) return null;
  return (
    <Button
      size="sm"
      variant={armed ? "destructive" : "ghost"}
      disabled={busy}
      className="shrink-0"
      onClick={(event) => {
        event.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setBusy(true);
        void rpc
          .call("stopThread", { threadId })
          .then((result) => {
            if (result.ok) toast.success("Stopped the agent");
            else toast.error(result.error ?? "Could not stop it");
            onStopped();
          })
          .catch((error: unknown) => toast.error(String(error)))
          .finally(() => {
            setBusy(false);
            setArmed(false);
          });
      }}
    >
      {armed ? "Stop — confirm" : "Stop"}
    </Button>
  );
}

/**
 * A closed-by-default section. The page should open as a scannable table of
 * contents — the request, the outcome, twenty updates — and you expand the one
 * you came for. Nothing here is short enough to be worth reading unasked.
 */
function Disclosure({
  title,
  meta,
  preview,
  children,
  defaultOpen = false,
}: {
  title: string;
  meta?: React.ReactNode;
  preview?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="group border-t border-border pt-4 [&[open]]:pb-1"
    >
      <summary className="-mx-2 cursor-pointer list-none rounded-md px-2 py-1 hover:bg-state-hover">
        <div className="flex items-baseline gap-2">
          <span
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-xs text-muted-foreground transition-transform group-open:rotate-90"
          >
            ▸
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-semibold text-foreground">
                {title}
              </span>
              {meta}
            </span>
            {preview !== undefined && preview !== "" ? (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground group-open:hidden">
                {preview}
              </span>
            ) : null}
          </span>
        </div>
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

/** An open section, for the few things that must be read without asking. */
function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2 border-t border-border pt-5">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {meta}
      </header>
      {children}
    </section>
  );
}

export function CardViewer({
  cardId,
  rpc,
  voice,
  onBack,
}: {
  cardId: string;
  rpc: Rpc;
  voice: VoiceAvailability;
  onBack: () => void;
}) {
  const navigate = useBbNavigate();
  const [card, setCard] = React.useState<BoardCard | null>(null);
  const [comments, setComments] = React.useState<Comment[]>([]);
  const [artifacts, setArtifacts] = React.useState<Artifact[]>([]);
  const [isLoading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const result = await rpc.call("cardDocument", { cardId });
      setCard(result.card);
      setComments(result.comments);
      setArtifacts(result.artifacts);
      setNotFound(result.card === null);
      if (result.error !== null) toast.error(result.error);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }, [cardId, rpc]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const comment = async () => {
    const body = draft.trim();
    if (body === "" || busy) return;
    setBusy(true);
    try {
      const result = await rpc.call("addCardComment", { cardId, body });
      if (!result.ok) {
        toast.error(result.error ?? "Comment failed");
        return;
      }
      setDraft("");
      toast.success(
        result.pending
          ? "Saved — it reaches the worker once the task is created."
          : result.notified > 0
            ? `Sent to ${result.notified} working thread${result.notified === 1 ? "" : "s"}.`
            : "Added to the task.",
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  const move = async (lane: BoardLane) => {
    const result = await rpc.call("moveCard", { cardId, lane });
    if (!result.ok) {
      toast.error(result.error ?? "That move was refused.");
      return;
    }
    if (result.dispatchedTo !== null) toast.success("Dispatched");
    await load();
  };

  if (isLoading) {
    return <p className="p-5 text-sm text-muted-foreground">Loading…</p>;
  }
  if (notFound || card === null) {
    return (
      <div className="space-y-3 p-5">
        <p className="text-sm text-muted-foreground">
          That card is no longer on the board — it may be archived, or its task
          was deleted.
        </p>
        <Button size="sm" variant="outline" onClick={onBack}>
          Back to the board
        </Button>
      </div>
    );
  }

  const summaries = comments.filter((entry) => entry.kind !== "system");
  const events = comments.filter((entry) => entry.kind === "system");

  return (
    <div className="h-full overflow-y-auto">
      {/* One measure, wide enough to read and narrow enough not to tire. */}
      <article className="mx-auto w-full max-w-4xl space-y-5 px-4 py-5 md:px-6">
        <Button size="sm" variant="ghost" className="-ml-2" onClick={onBack}>
          ← Board
        </Button>

        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {card.taskKey !== null ? (
              <span className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground">
                {card.taskKey}
              </span>
            ) : null}
            <span>{LANE_LABEL[card.lane]}</span>
            {card.projectName !== null ? <span>· {card.projectName}</span> : null}
            {card.stalled ? (
              <span className="text-destructive">· stalled</span>
            ) : null}
            {card.urgent ? (
              <span className="text-destructive">· urgent</span>
            ) : null}
            {card.priority !== "normal" ? <span>· {card.priority}</span> : null}
            {card.providerId !== null ? (
              <span title="Harness and model this work runs on">
                · {card.providerId}
                {card.model !== null ? ` / ${card.model}` : ""}
              </span>
            ) : null}
          </div>

          <h1 className="text-xl font-semibold leading-tight text-foreground">
            {card.title}
          </h1>

          {artifacts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {artifacts.map((artifact) => (
                <a
                  key={artifact.url}
                  href={artifact.url}
                  target="_blank"
                  rel="noreferrer"
                  title={artifact.url}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground hover:border-ring"
                >
                  <Icon
                    name={ARTIFACT_ICON[artifact.kind]}
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="truncate">{artifact.label}</span>
                </a>
              ))}
            </div>
          ) : card.pullRequestsUnavailable ? (
            <p className="text-xs text-muted-foreground">
              Could not reach the git host to look for a pull request.
            </p>
          ) : null}
        </header>

        {card.body.trim() !== "" ? (
          <Disclosure
            title="Request"
            preview={previewMarkdown(card.body)}
            meta={
              <span className="text-xs text-muted-foreground">
                {card.body.length.toLocaleString()} chars
              </span>
            }
          >
            <div className="min-w-0 overflow-x-auto">
              <Markdown content={card.body} />
            </div>
          </Disclosure>
        ) : null}

        {card.outcome !== null && card.outcome.trim() !== "" ? (
          <Disclosure
            title="Outcome"
            preview={previewMarkdown(card.outcome)}
          >
            <div className="min-w-0 overflow-x-auto">
              <Markdown content={card.outcome} />
            </div>
          </Disclosure>
        ) : null}

        {card.question !== null ? (
          <Section title="Waiting on you">
            <QuestionCard
              item={card.question}
              rpc={rpc}
              voice={voice}
              onNavigate={(threadId) => navigate.toThread(threadId)}
            />
          </Section>
        ) : null}

        {card.workers.length > 0 ? (
          <Disclosure
            title="Working on it"
            preview={`${card.workers.length} thread${card.workers.length === 1 ? "" : "s"}${
              card.workers.some(
                (worker) =>
                  worker.liveStatus === "active" ||
                  worker.liveStatus === "starting",
              )
                ? " · running now"
                : ""
            }`}
            defaultOpen={card.workers.some(
              (worker) =>
                worker.liveStatus === "active" ||
                worker.liveStatus === "starting",
            )}
          >
            <div className="space-y-1">
              {card.workers.map((worker) => (
                <div
                  key={worker.threadId}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate py-0.5 text-left text-sm text-foreground hover:underline"
                    onClick={() => navigate.toThread(worker.threadId)}
                  >
                    {worker.title ?? worker.threadId}
                  </button>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {worker.liveStatus ?? "idle"}
                  </span>
                  <StopWorker
                    threadId={worker.threadId}
                    isRunning={
                      worker.liveStatus === "active" ||
                      worker.liveStatus === "starting"
                    }
                    rpc={rpc}
                    onStopped={() => void load()}
                  />
                </div>
              ))}
            </div>
          </Disclosure>
        ) : null}

        <Section
          title={summaries.length === 1 ? "1 update" : `${summaries.length} updates`}
        >
          <div className="flex gap-2">
            <Input
              value={draft}
              placeholder="Add context — the worker gets it immediately"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void comment();
                }
              }}
            />
            <Button
              size="sm"
              disabled={busy || draft.trim() === ""}
              onClick={() => void comment()}
            >
              Send
            </Button>
          </div>

          {summaries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing written yet.
            </p>
          ) : (
            <div className="pt-1">
              {summaries.map((entry) => (
                <Disclosure
                  key={entry.id}
                  title={entry.threadTitle ?? entry.authorName}
                  preview={previewMarkdown(entry.body)}
                  meta={
                    <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                      <span>{when(entry.createdAt)}</span>
                      {entry.pending ? (
                        <span className="text-destructive">pending delivery</span>
                      ) : null}
                      <span>{entry.body.length.toLocaleString()} chars</span>
                    </span>
                  }
                >
                  <div className="min-w-0 overflow-x-auto">
                    <Markdown content={entry.body} />
                  </div>
                  {entry.threadId !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1 -ml-2"
                      onClick={() =>
                        entry.threadId !== null
                          ? navigate.toThread(entry.threadId)
                          : undefined
                      }
                    >
                      Open the thread that wrote this
                    </Button>
                  ) : null}
                </Disclosure>
              ))}
            </div>
          )}
        </Section>

        {events.length > 0 ? (
          <Disclosure
            title="History"
            preview={`${events.length} status change${events.length === 1 ? "" : "s"}`}
          >
            <ul className="space-y-1 text-xs text-muted-foreground">
              {events.map((entry) => (
                <li key={entry.id}>
                  {when(entry.createdAt)} — {entry.body}
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-border pt-5">
          {card.movable
            ? (["queue", "in_progress", "in_review", "done"] as BoardLane[])
                .filter((lane) => lane !== card.lane)
                .map((lane) => (
                  <Button
                    key={lane}
                    size="sm"
                    variant="outline"
                    onClick={() => void move(lane)}
                  >
                    → {LANE_LABEL[lane]}
                  </Button>
                ))
            : null}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() =>
              void rpc
                .call("archiveCard", { cardId })
                .then((result) => {
                  toastArchiveResult(result);
                  onBack();
                })
                .catch((error: unknown) => toast.error(String(error)))
            }
          >
            Archive
          </Button>
        </div>
      </article>
    </div>
  );
}

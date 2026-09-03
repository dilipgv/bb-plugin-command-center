/**
 * Pieces shared by the board and the reading view.
 *
 * These lived in app.tsx until the card modal was removed: the reading view
 * needs the answering block — with its voice input, snooze and dismiss — and
 * importing it from app.tsx would be circular, since app.tsx renders the viewer.
 */
import * as React from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useVoiceCapture } from "@/hooks/useVoiceCapture";
import type { InboxItem, rpcContract } from "./server";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type VoiceCapture = ReturnType<typeof useVoiceCapture>;

export interface VoiceAvailability {
  enabled: boolean;
  error: string | null;
}

export interface ArchiveCardResult {
  dismissedQuestion: boolean;
  archivedThreadIds: string[];
  threadErrors: { threadId: string; error: string }[];
}

/**
 * Say what actually happened — archiving a card can dismiss a question,
 * archive worker threads (worktrees included), both, or neither (a queued
 * request nobody had started on yet), and a silent "Archived" would hide
 * that from the one place it is worth knowing.
 */
export function toastArchiveResult(result: ArchiveCardResult): void {
  const n = result.archivedThreadIds.length;
  const parts = [
    result.dismissedQuestion ? "dismissed the question" : null,
    n > 0 ? `archived ${n} thread${n === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => part !== null);
  toast.success(parts.length > 0 ? `Archived — ${parts.join(", ")}.` : "Archived");
  if (result.threadErrors.length > 0) {
    const failed = result.threadErrors.length;
    toast.warning(
      `The card archived, but ${failed} thread${failed === 1 ? "" : "s"} did not — check ${failed === 1 ? "it" : "them"} directly.`,
    );
  }
}

export interface UnarchiveCardResult {
  unarchivedThreadIds: string[];
  threadErrors: { threadId: string; error: string }[];
}

export function toastUnarchiveResult(result: UnarchiveCardResult): void {
  const n = result.unarchivedThreadIds.length;
  toast.success(
    n > 0
      ? `Restored to the board — brought back ${n} thread${n === 1 ? "" : "s"}.`
      : "Restored to the board",
  );
  if (result.threadErrors.length > 0) {
    const failed = result.threadErrors.length;
    toast.warning(
      `The card is back, but ${failed} thread${failed === 1 ? "" : "s"} did not unarchive — check ${failed === 1 ? "it" : "them"} directly.`,
    );
  }
}

export function relative(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function untilLabel(ms: number): string {
  const minutes = Math.round((ms - Date.now()) / 60_000);
  if (minutes <= 0) return "due";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export function Chip({
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

/**
 * The one control for every voice affordance: idle mic, live stop button, and
 * a spinner while the clip is being transcribed.
 */
export function MicButton({
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
export function HeardLine({
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

export function QuestionCard({
  item,
  rpc,
  onNavigate,
  onResolved,
}: {
  item: InboxItem;
  rpc: Rpc;
  onNavigate: (threadId: string) => void;
  /**
   * Called after any action actually changes this item's state (dismissed,
   * snoozed) — the card itself never re-fetches, so without this the buttons
   * stay on screen looking live after they have already fired.
   */
  onResolved?: () => void;
}) {
  const [busy, setBusy] = React.useState(false);

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await rpc.call("dismiss", { id: item.id });
      if (result.ok) {
        toast.success("Dismissed");
      } else {
        toast.message("Already handled elsewhere — refreshing.");
      }
      onResolved?.();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const snooze = async (hours: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.call("snooze", {
        id: item.id,
        untilMs: Date.now() + hours * 3_600_000,
      });
      toast.success(`Snoozed ${hours}h`);
      onResolved?.();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
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
      </div>

      <p className="text-sm text-foreground">{item.question}</p>

      {/* No answer to give here — reply in the thread itself, then dismiss
          this notification once it's handled. */}
      <div className="flex flex-wrap gap-2">
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
        {item.threadId !== null ? (
          <Button size="sm" variant="outline" onClick={() => onNavigate(item.threadId!)}>
            Open asker's thread
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={() => void snooze(1)}>
          Snooze 1h
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void snooze(4)}>
          4h
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
    </article>
  );
}

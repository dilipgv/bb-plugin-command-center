/**
 * When has work gone quiet?
 *
 * Extracted as a pure decision because it cannot be tested any other way: the
 * activity sweep writes the real timestamp of the newest agent comment, so a
 * fabricated one is overwritten within the minute. That is correct behaviour —
 * the clock should not be forgeable — which leaves this function as the seam.
 */

export interface StallInput {
  /** Only work that claims to be in progress can stall. */
  isInProgress: boolean;
  /** Newest agent comment, when one has been seen. */
  lastCommentAt: number | null;
  /** When the underlying task was last touched, if known. */
  taskUpdatedAt: number | null;
  /** Fallback for a card that has neither. */
  createdAt: number;
  now: number;
  /** Null switches stall flagging off. */
  stallMs: number | null;
}

/**
 * The most recent moment anything is known to have happened on a card.
 *
 * `createdAt` is a FALLBACK, not a candidate: if it competed in the maximum then
 * any real signal older than the card's own timestamp would lose to it, and a
 * card could never stall. It is only used when nothing has been observed at all,
 * which is also what stops a task created last week and picked up this minute
 * from reading as instantly stalled — its task touch is recent.
 */
export function lastActivity(input: StallInput): number {
  const observed = [input.lastCommentAt, input.taskUpdatedAt].filter(
    (value): value is number => value !== null,
  );
  return observed.length > 0 ? Math.max(...observed) : input.createdAt;
}

export function isStalled(input: StallInput): boolean {
  if (!input.isInProgress || input.stallMs === null) return false;
  return input.now - lastActivity(input) > input.stallMs;
}

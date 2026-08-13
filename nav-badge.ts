/**
 * A count badge on the plugin's own sidebar row.
 *
 * BB has no API for this: `navPanel` takes no badge, and the host's sidebar
 * renders plugin rows without one. So this is a content script — full-trust page
 * code in the app shell — which finds our row and appends a span. It runs
 * wherever a bb window is open, including while another panel is in view, which
 * is the whole point of a badge.
 *
 * Two consequences of doing it this way, handled below: the row is React-owned
 * and re-renders wipe the span, so every tick re-asserts it rather than assuming
 * it survived; and matching the row by its label would fail once our own digits
 * are inside it, so the trailing count is stripped before comparing.
 */
const PANEL_TITLE = "Command Center";
const BADGE_ATTRIBUTE = "data-command-center-badge";
const POLL_MS = 8_000;

function findNavRow(): HTMLElement | null {
  // Array.from, not for..of: this plugin's tsconfig omits DOM.Iterable.
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("button, a"),
  );
  for (const candidate of candidates) {
    const label = (candidate.textContent ?? "")
      // Our own badge lives inside the row, so drop a trailing number.
      .replace(/\d+$/u, "")
      .trim();
    if (label === PANEL_TITLE) return candidate;
  }
  return null;
}

async function readCount(signal: AbortSignal): Promise<number | null> {
  try {
    const response = await fetch(
      "/api/v1/plugins/command-center/rpc/attention",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
        signal,
      },
    );
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "ok" in payload &&
      (payload as { ok: unknown }).ok === true
    ) {
      const result = (payload as { result?: { needsYou?: unknown } }).result;
      const count = result?.needsYou;
      return typeof count === "number" ? count : null;
    }
    return null;
  } catch {
    // A closing window aborts the fetch; nothing to report.
    return null;
  }
}

export function mountNavBadge({ signal }: { signal: AbortSignal }): () => void {
  const removeBadges = () => {
    document
      .querySelectorAll(`[${BADGE_ATTRIBUTE}]`)
      .forEach((node) => node.remove());
  };

  const tick = async () => {
    if (signal.aborted) return;
    const count = await readCount(signal);
    if (count === null || signal.aborted) return;

    const row = findNavRow();
    if (row === null || count <= 0) {
      removeBadges();
      return;
    }

    let badge = row.querySelector<HTMLElement>(`[${BADGE_ATTRIBUTE}]`);
    if (badge === null) {
      // Either the first run or React replaced the row; start clean so a
      // detached badge from a previous render cannot linger.
      removeBadges();
      badge = document.createElement("span");
      badge.setAttribute(BADGE_ATTRIBUTE, "");
      badge.setAttribute("aria-hidden", "true");
      // Inline, from theme variables: this element lives in the host's tree, so
      // it must not depend on the plugin stylesheet being applied there.
      badge.style.cssText = [
        "margin-left:auto",
        "flex:none",
        "min-width:1.15rem",
        "padding:0 0.3rem",
        "border-radius:9999px",
        "background:var(--destructive)",
        "color:var(--destructive-foreground)",
        "font-size:10px",
        "font-weight:600",
        "line-height:1.15rem",
        "text-align:center",
      ].join(";");
      row.appendChild(badge);
    }
    const label = `${count}`;
    if (badge.textContent !== label) badge.textContent = label;
    row.setAttribute(
      "title",
      `${count} ${count === 1 ? "item" : "items"} waiting on you`,
    );
  };

  void tick();
  const timer = window.setInterval(() => void tick(), POLL_MS);
  const stop = () => {
    window.clearInterval(timer);
    removeBadges();
  };
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}

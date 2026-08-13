/**
 * Chief's org panel, merged in from chief-nav. Exports its components; the
 * command center's app entry owns the slot registration.
 */
// bb-plugin-chief-nav — frontend entry.
//
// One nav panel, one conversation: Chief. The rail is the org Chief runs —
// Chief on top, its project chiefs beneath it, their task architects indented
// under those — and the right side is a real agent chat (the host's own
// ThreadChat), so the Chief pane behaves exactly like any BB thread.
//
// Nothing here pins threads: the rail is the organization, not a bookmark list.
import { useCallback, useEffect, useState } from "react";
import {
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  ChiefNavGroup,
  ChiefNavNeedsInput,
  ChiefNavTask,
  ChiefNavThread,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";

type Contract = typeof rpcContract;

interface State {
  chief: ChiefNavThread | null;
  chiefProjectId: string | null;
  groups: ChiefNavGroup[];
  needsInput: ChiefNavNeedsInput[];
  needsInputError: string | null;
}

const EMPTY: State = {
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
      // Roomier rows on touch, tighter once there is a pointer: the rail is a
      // tap target on a phone and a dense list on a desktop.
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
  const storageKey = `bb-plugin-chief-nav:${key}`;
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
  const rpc = useRpc<Contract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<State>(EMPTY);
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

/** Lane labels for the in-flight rail; unknown statuses print as themselves. */
const LANE_LABELS: Record<string, string> = {
  in_progress: "In progress",
  in_review: "In review",
  needs_input: "Needs input",
  todo: "To do",
  ready: "Ready",
  backlog: "Backlog",
};

const laneLabel = (status: string) =>
  LANE_LABELS[status] ?? status.replace(/_/g, " ");

/**
 * The task board's unfinished rows. This is not fed by plugin signals — the
 * Tasks plugin publishes on its own channel, which this plugin cannot
 * subscribe to — so it polls while mounted and refetches on demand.
 */
function useInFlight(enabled: boolean) {
  const rpc = useRpc<Contract>();
  const [tasks, setTasks] = useState<ChiefNavTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isTruncated, setTruncated] = useState(false);
  const [isLoading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const result = await rpc.call("inFlight");
    setTasks(result.tasks);
    setError(result.error);
    setTruncated(result.truncated);
    setLoading(false);
  }, [rpc]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  return { tasks, error, isTruncated, isLoading, refresh };
}

function InFlightRail({
  isWide,
  selected,
  onOpenThread,
  onClose,
}: {
  isWide: boolean;
  selected: string | null;
  onOpenThread: (threadId: string) => void;
  onClose: () => void;
}) {
  const { tasks, error, isTruncated, isLoading, refresh } = useInFlight(true);

  const lanes: { status: string; tasks: ChiefNavTask[] }[] = [];
  for (const task of tasks) {
    const lane = lanes.find((entry) => entry.status === task.status);
    if (lane) lane.tasks.push(task);
    else lanes.push({ status: task.status, tasks: [task] });
  }

  return (
    <aside
      className={`z-20 min-w-0 flex-col overflow-y-auto border-border bg-background p-2 ${
        isWide
          ? "static w-72 shrink-0 border-l"
          : "absolute inset-y-0 right-0 w-[19rem] max-w-[88%] border-l shadow-lg"
      } flex`}
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          In flight{tasks.length > 0 ? ` (${tasks.length})` : ""}
        </p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh in-flight tasks"
            onClick={() => void refresh()}
          >
            <span aria-hidden>↻</span>
          </Button>
          {!isWide ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Close in-flight tasks"
              onClick={onClose}
            >
              <span aria-hidden>✕</span>
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="px-1 text-xs text-muted-foreground">
          Tasks unavailable — the Tasks plugin did not answer.
        </p>
      ) : isLoading ? (
        <p className="px-1 text-xs text-muted-foreground">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          Nothing in flight. Every task on the board is done or canceled.
        </p>
      ) : (
        lanes.map((lane) => (
          <div key={lane.status} className="pt-2">
            <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
              {laneLabel(lane.status)} · {lane.tasks.length}
            </p>
            {lane.tasks.map((task) => (
              <div
                key={task.taskId}
                className="mb-1 rounded-md border border-border bg-card p-2"
              >
                <div className="flex items-start gap-1.5">
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-foreground">
                    {task.key}
                  </span>
                  {task.priority !== "none" ? (
                    <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                      {task.priority}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-foreground">
                  {task.title}
                </p>
                {task.workers.length === 0 ? (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    No thread attached
                  </p>
                ) : (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {task.workers.map((worker) => (
                      <button
                        key={worker.threadId}
                        type="button"
                        onClick={() => onOpenThread(worker.threadId)}
                        className={`flex items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] transition-colors md:py-0.5 ${
                          selected === worker.threadId
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/50"
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`size-1.5 shrink-0 rounded-full ${
                            worker.liveStatus === "running" ||
                            worker.liveStatus === "active"
                              ? "bg-primary animate-pulse"
                              : worker.liveStatus === "failed" ||
                                  worker.liveStatus === "error"
                                ? "bg-destructive"
                                : "bg-muted-foreground/40"
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {worker.title ?? worker.threadId}
                        </span>
                        {/* Whose work this is: Chief's org, or someone else's. */}
                        <span className="shrink-0 text-[9px] uppercase tracking-wide">
                          {worker.isChiefOrg ? "chief" : "other"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))
      )}

      {isTruncated ? (
        <p className="mt-2 px-1 text-[10px] text-muted-foreground">
          Showing the 60 most recent open tasks — the board has more.
        </p>
      ) : null}
    </aside>
  );
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

  // The in-flight rail is the same story on the right, and only wide layouts
  // have room for both at once.
  const [isTasksPinned, setTasksPinned] = useRailPreference(
    "tasks-visible",
    true,
  );
  const [isTasksDrawerOpen, setTasksDrawerOpen] = useState(false);
  const isTasksShown = isWide ? isTasksPinned : isTasksDrawerOpen;
  const toggleTasks = () => {
    if (isWide) {
      setTasksPinned(!isTasksPinned);
      return;
    }
    // One drawer at a time on a phone.
    setDrawerOpen(false);
    setTasksDrawerOpen(!isTasksDrawerOpen);
  };

  // The open thread lives in the route, so a conversation is deep-linkable and
  // browser back walks the rail. Chief is the default.
  const selected = subPath || state.chief?.threadId || null;
  const select = (threadId: string) => {
    navigate.toPluginPanel("chief", { subPath: threadId });
    // Only a drawer is in the way of what you just opened; a pinned column
    // stays put.
    setDrawerOpen(false);
    setTasksDrawerOpen(false);
  };

  useEffect(() => {
    if (isWide || (!isDrawerOpen && !isTasksDrawerOpen)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDrawerOpen(false);
      setTasksDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isWide, isDrawerOpen, isTasksDrawerOpen]);

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
      {!isWide && (isDrawerOpen || isTasksDrawerOpen) ? (
        <button
          type="button"
          aria-label="Close the list"
          onClick={() => {
            setDrawerOpen(false);
            setTasksDrawerOpen(false);
          }}
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
                  {/* The thread's own title, so renaming the thread renames the
                      row; the project it owns is the second line. */}
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
                  <span className="mt-0.5 block line-clamp-2 text-muted-foreground">
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
        {/* One bar at every width: the rail's toggle, where you are, and the
            actions for a subordinate thread. */}
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
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            aria-label={
              isTasksShown ? "Hide in-flight tasks" : "Show in-flight tasks"
            }
            aria-expanded={isTasksShown}
            onClick={toggleTasks}
          >
            <span aria-hidden className="text-base leading-none">
              {isTasksShown ? "⟩" : "☱"}
            </span>
          </Button>
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
              {/* The rail's Start button is off-screen on a phone, so the empty
                  state carries its own. */}
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

      {isTasksShown ? (
        <InFlightRail
          isWide={isWide}
          selected={selected}
          onOpenThread={select}
          onClose={() => setTasksDrawerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The panel's header summary. It answers three questions in order: is Chief
 * alive, how many of its threads are mid-turn, and how much unfinished work
 * exists on the board — including work Chief did not spawn.
 */
function ChiefHeader() {
  const { state } = useChiefState();
  const { tasks } = useInFlight(true);

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
  if (tasks.length > 0) parts.push(`${tasks.length} in flight`);
  if (state.needsInput.length > 0) {
    parts.push(`${state.needsInput.length} waiting on you`);
  }

  return (
    <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>
  );
}

export { ChiefPanel, ChiefHeader };

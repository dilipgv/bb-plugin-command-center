// Chief — the org that works the command center's queue.
//
// Merged in from the standalone chief-nav plugin. It keeps its own rpc methods,
// settings, agent tools and nav panel. What it no longer owns: the plugin's one
// CLI command (handed back to the host module and mounted under
// `bb inbox chief …`) and the database handle plus migrations, which the host
// owns so both halves share a single file.
//
// The operating model this plugin enforces:
//   The Captain (the user) talks ONLY to Chief. There is exactly ONE Chief
//   thread, and it is global — it is not tied to a project. Chief does no
//   substantive work: it stands up a **project chief** per project and manages
//   them. Each project chief owns its project: it creates BB tasks and hands
//   them to task architects with a complete brief. Nobody below Chief addresses
//   the Captain directly — they ask through the Inbox, or point at a thread for
//   review.
//
// Nothing is pinned. The nav panel is the surface: Chief on top, its project
// chiefs beneath it, their architects beneath those.
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@bb/plugin-sdk";
import { z } from "zod";

/** The shared plugin database, opened and migrated by the host module. */
export type ChiefDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

/** What Chief needs from the Inbox half, passed in rather than fetched. */
export interface ChiefDeps {
  /** Open, non-snoozed questions shaped for the nav's needs-input rail. */
  openQuestions: () => ChiefNavNeedsInput[];
}

/** Realtime channel — the frontend refetches `state` whenever this fires. */
const CHANNEL = "state";

/** How Chief bootstraps: the one-word trigger its global contract listens for. */
const CHIEF_BOOTSTRAP_PROMPT = "Chief";

const threadStatus = z.enum(["starting", "active", "idle", "stopping", "error"]);

const navThread = z.object({
  threadId: z.string(),
  title: z.string(),
  status: threadStatus.nullable(),
  /** Set for task architects: the BB task they own. */
  taskKey: z.string().nullable(),
  /** One-line mission or charter, for the rail's second line. */
  subtitle: z.string().nullable(),
  retired: z.boolean(),
  createdAt: z.number().nullable(),
});

const needsInputItem = z.object({
  id: z.string(),
  question: z.string(),
  task: z.string(),
  taskKey: z.string().nullable(),
  askedBy: z.string().nullable(),
  urgent: z.boolean(),
  /** The thread the Captain is being asked to look at, when there is one. */
  reviewThreadId: z.string().nullable(),
  /** The thread that is blocked on the answer. */
  askerThreadId: z.string().nullable(),
});


/** One project chief and the architects it is running. */
const projectGroup = z.object({
  projectId: z.string(),
  projectName: z.string(),
  chief: navThread,
  architects: z.array(navThread),
});

export type ChiefNavThread = z.infer<typeof navThread>;
export type ChiefNavNeedsInput = z.infer<typeof needsInputItem>;
export type ChiefNavGroup = z.infer<typeof projectGroup>;

export const rpcContract = defineRpcContract({
  state: {
    input: z.null(),
    output: z.object({
      /** The single global Chief thread, or null before it is started. */
      chief: navThread.nullable(),
      /** Where Chief's own thread lives (a project is required to hold it). */
      chiefProjectId: z.string().nullable(),
      groups: z.array(projectGroup),
      needsInput: z.array(needsInputItem),
      /** Non-null only when the Inbox plugin is unreachable. */
      needsInputError: z.string().nullable(),
    }),
  },
  ensureChief: {
    input: z.null(),
    output: z.object({ threadId: z.string(), created: z.boolean() }),
  },
  /** Promote an existing thread to Chief (e.g. after a provider migration). */
  adoptChief: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  setRetired: {
    input: z.object({ threadId: z.string(), retired: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

interface ChiefRow {
  thread_id: string;
  project_id: string;
  created_at: number;
}

interface ProjectChiefRow {
  project_id: string;
  thread_id: string;
  charter: string | null;
  created_at: number;
  retired: number;
}

interface ArchitectRow {
  thread_id: string;
  project_id: string;
  chief_thread_id: string | null;
  task_key: string | null;
  title: string;
  mission: string | null;
  created_at: number;
  retired: number;
  parent_thread_id: string | null;
}

/** Tiny argv parser: `--flag value`, `--flag=value`, repeatable, positionals. */
function parseArgs(argv: string[]) {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s);
    const name = rawName!;
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = "true";
      }
    }
    const existing = flags.get(name);
    if (existing) existing.push(value);
    else flags.set(name, [value]);
  }
  return {
    positional,
    all: (name: string) => flags.get(name) ?? [],
    one: (name: string) => flags.get(name)?.[0],
    bool: (name: string) => {
      const value = flags.get(name)?.[0];
      return value !== undefined && value !== "false";
    },
  };
}

const projectChiefParams = z.object({
  projectId: z
    .string()
    .min(1)
    .describe(
      "BB project id (proj_…) this chief owns. Use chief_roster to list projects.",
    ),
  charter: z
    .string()
    .min(1)
    .describe(
      "What this project chief owns: the product, its current priorities, the standards it holds, and anything it must never do. It reads this once, at birth — make it complete.",
    ),
});

const handoffParams = z.object({
  taskKey: z
    .string()
    .min(1)
    .describe(
      "The BB task this architect owns, e.g. BBC-12. Create it with `bb tasks create` FIRST — a handoff without a task is not allowed.",
    ),
  title: z
    .string()
    .min(1)
    .describe("Short title for the architect thread, without the task key."),
  mission: z
    .string()
    .min(1)
    .describe(
      "The brief: what outcome this architect owns and why, in enough detail that it never has to ask what the task means.",
    ),
  successCriteria: z
    .array(z.string())
    .optional()
    .describe("Observable conditions that mean the task is done."),
  constraints: z
    .array(z.string())
    .optional()
    .describe("Boundaries: what not to touch, required approach, invariants."),
  context: z
    .string()
    .optional()
    .describe("Prior decisions, links, thread ids, files worth reading first."),
  projectId: z
    .string()
    .optional()
    .describe("Defaults to the calling thread's project."),
  environment: z
    .enum(["worktree", "project-default"])
    .optional()
    .describe(
      "Workspace for the architect. Defaults to the plugin setting (worktree for PR-producing work).",
    ),
});

export async function registerChief(
  bb: BbPluginApi,
  db: ChiefDatabase,
  deps: ChiefDeps,
) {
  const settings = bb.settings.define({
    chiefProject: {
      type: "project",
      label: "Where Chief's own thread lives",
    },
    architectWorkspace: {
      type: "select",
      label: "Task architect workspace",
      options: ["worktree", "project-default"],
      default: "worktree",
    },
    hideSubordinateThreads: {
      type: "boolean",
      label:
        "Keep project chiefs and task architects out of the sidebar (this panel and their tasks still list them)",
      default: true,
    },
    hideChiefThread: {
      type: "boolean",
      label:
        "Keep the Chief thread itself out of the sidebar (the Chief panel is then its only entry point, and it stops contributing unread badges)",
      default: true,
    },
    architectTitlePrefix: {
      type: "boolean",
      label: "Prefix architect thread titles with the task key",
      default: true,
    },
  });


  const selectArchitects = db.prepare<[string]>(
    `SELECT * FROM architects WHERE project_id = ? ORDER BY retired ASC, created_at DESC`,
  );

  const chiefRow = () =>
    (db.prepare(`SELECT * FROM chief WHERE id = 1`).get() as
      | ChiefRow
      | undefined) ?? null;

  const projectChiefRow = (projectId: string) =>
    (db.prepare(`SELECT * FROM project_chiefs WHERE project_id = ?`).get(
      projectId,
    ) as ProjectChiefRow | undefined) ?? null;

  /**
   * Role lookups, kept in memory because `bb.agents.configure` is synchronous
   * and sits on the thread-start path. Rebuilt from the db at load and after
   * every write, so a reload never loses the mapping.
   */
  let chiefThreadId: string | null = null;
  const projectChiefThreads = new Set<string>();
  const architectThreads = new Set<string>();

  function reloadRoles() {
    chiefThreadId = chiefRow()?.thread_id ?? null;
    projectChiefThreads.clear();
    architectThreads.clear();
    for (const row of db
      .prepare(`SELECT thread_id FROM project_chiefs`)
      .all() as { thread_id: string }[]) {
      projectChiefThreads.add(row.thread_id);
    }
    for (const row of db
      .prepare(`SELECT thread_id FROM architects WHERE retired = 0`)
      .all() as { thread_id: string }[]) {
      architectThreads.add(row.thread_id);
    }
  }
  reloadRoles();

  const publish = () => bb.realtime.publish(CHANNEL, { changedAt: Date.now() });

  function recordChief(threadId: string, projectId: string) {
    db.prepare(
      `INSERT INTO chief (id, thread_id, project_id, created_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id,
                                     project_id = excluded.project_id`,
    ).run(threadId, projectId, Date.now());
    reloadRoles();
    publish();
  }

  function recordProjectChief(
    projectId: string,
    threadId: string,
    charter: string,
  ) {
    db.prepare(
      `INSERT INTO project_chiefs (project_id, thread_id, charter, created_at, retired)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(project_id) DO UPDATE SET thread_id = excluded.thread_id,
         charter = excluded.charter, retired = 0`,
    ).run(projectId, threadId, charter, Date.now());
    reloadRoles();
    publish();
  }

  function recordArchitect(row: Omit<ArchitectRow, "retired">) {
    db.prepare(
      `INSERT INTO architects (thread_id, project_id, chief_thread_id, parent_thread_id,
                               task_key, title, mission, created_at, retired)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(thread_id) DO UPDATE SET task_key = excluded.task_key,
         title = excluded.title, mission = excluded.mission,
         parent_thread_id = excluded.parent_thread_id, retired = 0`,
    ).run(
      row.thread_id,
      row.project_id,
      row.chief_thread_id,
      row.parent_thread_id,
      row.task_key,
      row.title,
      row.mission,
      row.created_at,
    );
    reloadRoles();
    publish();
  }

  /** Live status for a thread; null when it is gone or unreadable. */
  async function statusOf(threadId: string) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return {
        status: thread.status as z.infer<typeof threadStatus>,
        title: thread.title ?? null,
      };
    } catch {
      return null;
    }
  }

  async function listProjects() {
    // Personal is a real place to run Chief, so it belongs in the picture.
    return (await bb.sdk.projects.list({ includePersonal: true })).map(
      (project) => ({ id: project.id, name: project.name, kind: project.kind }),
    );
  }

  /** Where Chief's own thread lives: the setting, else Personal, else the first. */
  async function chiefHomeProject() {
    const { chiefProject } = await settings.get();
    const projects = await listProjects();
    if (chiefProject && projects.some((entry) => entry.id === chiefProject)) {
      return chiefProject;
    }
    return (
      projects.find((entry) => entry.kind === "personal")?.id ??
      projects[0]?.id ??
      null
    );
  }

  /** Open Inbox items, so the nav can show what is blocked on the Captain. */
  /** Open Inbox items — now an in-process read, not a cross-plugin call. */
  function needsInput(): {
    items: z.infer<typeof needsInputItem>[];
    error: string | null;
  } {
    return { items: deps.openQuestions(), error: null };
  }


  const bullets = (items?: string[]) =>
    items && items.length > 0
      ? items.map((entry) => `- ${entry}`).join("\n")
      : "- (none stated — use your judgment and say so in your first report)";

  /**
   * The frame every project chief starts with. Chief supplies the charter; the
   * plugin guarantees the shape and the chain of command, so no two project
   * chiefs drift apart.
   */
  function projectChiefBrief(input: {
    projectName: string;
    charter: string;
    chiefThreadId: string | null;
  }) {
    return [
      `You are the **project chief** for ${input.projectName}. Chief stood you up and manages you; you own this project's execution.`,
      "",
      "## Charter",
      input.charter,
      "",
      "## Chain of command",
      "- The Captain (the user) talks only to Chief. **Never** address the Captain directly.",
      `- You report to Chief${input.chiefThreadId ? ` (thread ${input.chiefThreadId})` : ""}. Chief decides what reaches the Captain.`,
      "- You do orchestration for this project, not the work itself. For each unit of work: create the BB task, then hand it to a task architect with `chief_handoff`, then track it.",
      "- You cannot create other project chiefs. If this work belongs to a different project, say so and let Chief place it.",
      "",
      "## The loop",
      "1. `bb tasks create --title \"…\" --description \"…\" --json` → note the key.",
      "2. `chief_handoff` with the task key plus mission, success criteria, constraints, and context.",
      "3. `bb tasks attach <key> --thread <architect-thread-id>` so the board matches reality.",
      "4. Track with `chief_roster`; keep task status current; never merge a PR.",
      "",
      "## When you need the Captain",
      "- Decisions go through the Inbox with a recommendation and 2–3 choices: `bb inbox ask --task \"<key>\" --question \"…\" --option \"…\" --option \"…\" --asked-by \"project chief: " +
        `${input.projectName}"\`.`,
      "- For something they should look at, point at the thread: `bb inbox review --task \"<key>\" --question \"…\" --thread <thread-id>`.",
      "",
      "Report in precise Markdown bullets: verdict or recommendation first, then blockers, evidence, next action, and any decision you need.",
      "",
      "Acknowledge with your read of the charter in five bullets or fewer, then wait for work.",
    ].join("\n");
  }

  /** The frame every task architect starts with. */
  function architectBrief(input: {
    taskKey: string;
    title: string;
    mission: string;
    successCriteria?: string[];
    constraints?: string[];
    context?: string;
    projectName: string;
  }) {
    return [
      `You are a **task architect** on ${input.projectName}, working task **${input.taskKey}**: ${input.title}.`,
      "",
      "The project chief delegated this to you and owns the reporting line upward. You own the outcome of this one task, end to end.",
      "",
      "## Mission",
      input.mission,
      "",
      "## Done means",
      bullets(input.successCriteria),
      "",
      "## Constraints",
      bullets(input.constraints),
      ...(input.context ? ["", "## Context", input.context] : []),
      "",
      "## Protocol",
      `- Keep task ${input.taskKey} current: \`bb tasks update ${input.taskKey} --status <status>\`, and \`bb tasks comment ${input.taskKey}\` for decisions worth keeping.`,
      "- Never message the Captain directly. If you need a decision, an approval, or a missing value, ask through the Inbox: `bb inbox ask --task " +
        `"${input.taskKey}" --question "..." --option A --option B --asked-by "architect: ${input.taskKey}"\`. Recommend an option; do not stall.`,
      `- When something needs the Captain's eyes, point at the thread instead of pasting it: \`bb inbox review --task "${input.taskKey}" --question "..." --thread <thread-id> --asked-by "architect: ${input.taskKey}"\`.`,
      "- Delegate substantive execution to subagents where it helps, but keep the architecture, sequencing, and verification yours.",
      "- Report in precise Markdown bullets, led by the verdict or recommendation, then blockers, evidence, and next action.",
      "",
      "Start by restating the plan in five bullets or fewer, then begin.",
    ].join("\n");
  }

  async function resolveProjectName(projectId: string) {
    try {
      return (await bb.sdk.projects.get({ projectId })).name;
    } catch {
      // `projects.get` does not serve the singleton personal project — it
      // answers project_not_found — so fall back to the list that includes it
      // before giving up on a real name.
      try {
        const match = (await listProjects()).find(
          (project) => project.id === projectId,
        );
        if (match) return match.name;
      } catch {
        // Both lookups failed; the caller gets a generic name below.
      }
      return "this project";
    }
  }

  /** Create the one global Chief thread and bootstrap it with its contract. */
  async function ensureChief() {
    const existing = chiefRow();
    if (existing) {
      // A deleted thread must not strand the Captain without a Chief.
      if (await statusOf(existing.thread_id)) {
        return { threadId: existing.thread_id, created: false };
      }
      db.prepare(`DELETE FROM chief WHERE id = 1`).run();
      reloadRoles();
    }
    const projectId = await chiefHomeProject();
    if (!projectId) {
      throw new Error("no BB project available to hold the Chief thread");
    }
    const { hideChiefThread } = await settings.get();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      title: "Chief",
      // The Chief panel is the entry point, so by default Chief stays out of the
      // sidebar too. Trade-off: a hidden thread contributes no unread or
      // favicon attention, so the panel header's counts become the only signal.
      ...(hideChiefThread ? { visibility: "hidden" as const } : {}),
      prompt: CHIEF_BOOTSTRAP_PROMPT,
    });
    recordChief(thread.id, projectId);
    bb.log.info(`chief thread ${thread.id} created in ${projectId}`);
    return { threadId: thread.id, created: true };
  }

  /** Stand up (or return) the project chief for one project. */
  async function ensureProjectChief(params: z.infer<typeof projectChiefParams>) {
    const existing = projectChiefRow(params.projectId);
    if (existing && (await statusOf(existing.thread_id))) {
      return {
        threadId: existing.thread_id,
        created: false,
        projectId: params.projectId,
      };
    }
    const projectName = await resolveProjectName(params.projectId);
    const { hideSubordinateThreads } = await settings.get();
    // Deliberately parentless. A `parentThreadId` is what builds BB's sidebar
    // tree, and the org belongs in this plugin's rail, not nested in the
    // sidebar. The project_chiefs table carries the hierarchy instead, which
    // also sidesteps BB's same-project parent validation entirely.
    const thread = await bb.sdk.threads.spawn({
      projectId: params.projectId,
      title: `Project chief — ${projectName}`,
      // Subordinates live in this panel and on their tasks, not in the sidebar.
      // Hidden threads stay out of sidebar organization and unread attention,
      // but remain fully listable, openable, and attachable.
      ...(hideSubordinateThreads ? { visibility: "hidden" as const } : {}),
      environment: { type: "project-default" },
      prompt: projectChiefBrief({
        projectName,
        charter: params.charter,
        // The brief names Chief for the chain of command, which is true whether
        // or not the sidebar parent link was legal here.
        chiefThreadId,
      }),
    });
    recordProjectChief(params.projectId, thread.id, params.charter);
    bb.log.info(`project chief ${thread.id} created for ${params.projectId}`);
    return { threadId: thread.id, created: true, projectId: params.projectId };
  }

  async function handoff(
    params: z.infer<typeof handoffParams>,
    callerThreadId: string | null,
  ) {
    const { architectWorkspace, architectTitlePrefix, hideSubordinateThreads } =
      await settings.get();
    let projectId = params.projectId;
    if (!projectId && callerThreadId) {
      projectId = (await bb.sdk.threads.get({ threadId: callerThreadId }))
        .projectId;
    }
    if (!projectId) {
      throw new Error(
        "no project — pass projectId (the calling thread has none)",
      );
    }

    // Also parentless, for the same reason as project chiefs. Who this
    // architect answers to is recorded in the architects table (and stated in
    // its brief), not expressed as a BB thread parent.
    const registeredProjectChief = projectChiefRow(projectId)?.thread_id ?? null;
    const reportsTo =
      callerThreadId && projectChiefThreads.has(callerThreadId)
        ? callerThreadId
        : (registeredProjectChief ?? chiefThreadId);

    const workspace = params.environment ?? architectWorkspace;
    const title = architectTitlePrefix
      ? `${params.taskKey} — ${params.title}`
      : params.title;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      title,
      // Same rule as project chiefs: the rail and the task are where these
      // live, so they never appear in the sidebar.
      ...(hideSubordinateThreads ? { visibility: "hidden" as const } : {}),
      environment:
        workspace === "worktree"
          ? {
              type: "host",
              workspace: {
                type: "managed-worktree",
                baseBranch: { kind: "default" },
              },
            }
          : { type: "project-default" },
      prompt: architectBrief({
        ...params,
        projectName: await resolveProjectName(projectId),
      }),
    });

    recordArchitect({
      thread_id: thread.id,
      project_id: projectId,
      chief_thread_id: chiefThreadId,
      parent_thread_id: reportsTo,
      task_key: params.taskKey,
      title: params.title,
      mission: params.mission,
      created_at: Date.now(),
    });
    bb.log.info(`handed ${params.taskKey} to task architect ${thread.id}`);
    return { threadId: thread.id, projectId, title };
  }

  /** The whole org, with live thread status. Shared by rpc, tools, and cli. */
  async function roster() {
    const chief = chiefRow();
    const chiefLive = chief ? await statusOf(chief.thread_id) : null;
    const projects = await listProjects();
    const groups: z.infer<typeof projectGroup>[] = [];

    for (const project of projects) {
      const row = projectChiefRow(project.id);
      if (!row) continue;
      const live = await statusOf(row.thread_id);
      if (!live) continue; // thread deleted — drop the group rather than show a corpse
      const architects = await Promise.all(
        (selectArchitects.all(project.id) as ArchitectRow[]).map(
          async (architect) => {
            const architectLive = await statusOf(architect.thread_id);
            return {
              threadId: architect.thread_id,
              title: architectLive?.title ?? architect.title,
              status: architectLive?.status ?? null,
              taskKey: architect.task_key,
              subtitle: architect.mission,
              retired: architect.retired === 1,
              createdAt: architect.created_at,
            };
          },
        ),
      );
      groups.push({
        projectId: project.id,
        projectName: project.name,
        chief: {
          threadId: row.thread_id,
          // The thread's own name is what the user renamed it to, so it wins.
          title: live.title ?? `Project chief — ${project.name}`,
          status: live.status,
          taskKey: null,
          // The project, not the charter's first line — a brief's opening
          // sentence is prose, not a label.
          subtitle: project.name,
          retired: row.retired === 1,
          createdAt: row.created_at,
        },
        architects: architects.filter((entry) => entry.status !== null),
      });
    }

    return {
      chief:
        chief && chiefLive
          ? {
              threadId: chief.thread_id,
              title: chiefLive.title ?? "Chief",
              status: chiefLive.status,
              taskKey: null,
              subtitle: null,
              retired: false,
              createdAt: chief.created_at,
            }
          : null,
      chiefProjectId: chief?.project_id ?? null,
      groups,
      projects,
    };
  }

  // ---------------------------------------------------------------- frontend

  bb.rpc.register(rpcContract, {
    state: async () => {
      const [{ chief, chiefProjectId, groups }, inbox] = await Promise.all([
        roster(),
        needsInput(),
      ]);
      return {
        chief,
        chiefProjectId,
        groups,
        needsInput: inbox.items,
        needsInputError: inbox.error,
      };
    },

    ensureChief: () => ensureChief(),

    adoptChief: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      recordChief(threadId, thread.projectId);
      return { ok: true };
    },

    setRetired: ({ threadId, retired }) => {
      const value = retired ? 1 : 0;
      const changed =
        db
          .prepare(`UPDATE architects SET retired = ? WHERE thread_id = ?`)
          .run(value, threadId).changes +
        db
          .prepare(`UPDATE project_chiefs SET retired = ? WHERE thread_id = ?`)
          .run(value, threadId).changes;
      reloadRoles();
      publish();
      return { ok: changed > 0 };
    },
  });

  // The rail shows live thread status, so every lifecycle transition of a
  // thread we track is a reason to refetch.
  const republishIfTracked = ({ thread }: { thread: { id: string } }) => {
    if (
      thread.id === chiefThreadId ||
      projectChiefThreads.has(thread.id) ||
      architectThreads.has(thread.id)
    ) {
      publish();
    }
  };
  bb.events.on("thread.active", republishIfTracked);
  bb.events.on("thread.idle", republishIfTracked);
  bb.events.on("thread.failed", republishIfTracked);
  bb.events.on("thread.archived", republishIfTracked);
  bb.events.on("thread.deleted", ({ thread }) => {
    db.prepare(`DELETE FROM architects WHERE thread_id = ?`).run(thread.id);
    db.prepare(`DELETE FROM project_chiefs WHERE thread_id = ?`).run(thread.id);
    db.prepare(`DELETE FROM chief WHERE thread_id = ?`).run(thread.id);
    reloadRoles();
    publish();
  });

  // ------------------------------------------------------------------ agents

  bb.agents.registerTool({
    name: "chief_project_chief",
    description:
      "Stand up (or return) the project chief that owns one BB project, briefed with a charter. Chief-only: this is how Chief delegates a whole project rather than a single task.",
    instructions:
      "Chief never works a project directly. Give each project a project chief with chief_project_chief, then send work to that thread.",
    experimental_statusLabels: {
      pending: "Standing up a project chief",
      completed: "Stood up a project chief",
    },
    parameters: projectChiefParams,
    async execute(params) {
      const result = await ensureProjectChief(params);
      return result.created
        ? `Project chief for ${params.projectId} is thread ${result.threadId}. Send it work with \`bb thread tell ${result.threadId} "…"\`; it creates the tasks and hands them to task architects.`
        : `Project chief for ${params.projectId} already exists: thread ${result.threadId}.`;
    },
  });

  bb.agents.registerTool({
    name: "chief_handoff",
    description:
      "Hand a BB task to a freshly spawned task architect with a complete brief. Requires an existing task key — create it with `bb tasks create` first. Returns the architect thread id.",
    instructions:
      "Delegate with chief_handoff instead of doing the work yourself. It composes the architect's brief from your mission/criteria/constraints, spawns the thread under you, and registers it in the Chief nav.",
    experimental_statusLabels: {
      pending: "Handing off to a task architect",
      completed: "Handed off to a task architect",
    },
    parameters: handoffParams,
    async execute(params, ctx) {
      const result = await handoff(params, ctx.threadId ?? null);
      return [
        `Handed ${params.taskKey} to task architect thread ${result.threadId} ("${result.title}").`,
        `Attach it to the task so the board reflects reality: \`bb tasks attach ${params.taskKey} --thread ${result.threadId}\`.`,
        "It reports back here; escalate only decisions and blockers upward.",
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "chief_roster",
    description:
      "The live org: BB projects, their project chiefs, each chief's task architects with thread status, and everything currently waiting on the Captain. Use it instead of memory to build a digest.",
    experimental_statusLabels: {
      pending: "Reading the Chief roster",
      completed: "Read the Chief roster",
    },
    parameters: z.object({
      projectId: z
        .string()
        .optional()
        .describe("Limit to one project. Omit for the whole org."),
    }),
    async execute({ projectId }) {
      const [{ chief, groups, projects }, inbox] = await Promise.all([
        roster(),
        needsInput(),
      ]);
      const scoped = projectId
        ? groups.filter((group) => group.projectId === projectId)
        : groups;
      const lines: string[] = [
        `Chief: ${chief ? `${chief.threadId} [${chief.status}]` : "not started"}`,
      ];
      if (!projectId) {
        const unmanaged = projects.filter(
          (project) =>
            !groups.some((group) => group.projectId === project.id),
        );
        lines.push(
          unmanaged.length === 0
            ? "Every project has a chief."
            : `Projects with no chief yet: ${unmanaged
                .map((project) => `${project.name} (${project.id})`)
                .join(", ")}`,
        );
      }
      for (const group of scoped) {
        lines.push(
          "",
          `${group.projectName} (${group.projectId})`,
          `  project chief: ${group.chief.threadId} [${group.chief.status}]${
            group.chief.retired ? " (retired)" : ""
          }`,
        );
        if (group.architects.length === 0) {
          lines.push("  architects: none");
        }
        for (const architect of group.architects) {
          lines.push(
            `  ${architect.taskKey ?? "(no task)"}  ${architect.title}  [${
              architect.status
            }${architect.retired ? ", retired" : ""}]  ${architect.threadId}`,
          );
        }
      }
      if (inbox.items.length > 0) {
        lines.push("", "Waiting on the Captain:");
        for (const item of inbox.items) {
          lines.push(
            `- [${item.taskKey ?? item.task}] ${item.question}${
              item.askedBy ? ` (${item.askedBy})` : ""
            } — inbox ${item.id}`,
          );
        }
      }
      return lines.join("\n");
    },
  });

  // Role-aware sessions. Each tier gets exactly the skill and the tools its
  // level of the hierarchy is allowed to use, so the chain of command cannot
  // invert itself: only Chief creates project chiefs, only project chiefs and
  // Chief hand off tasks, architects delegate to subagents and report upward.
  bb.agents.configure((context) => {
    if (context.thread.id === chiefThreadId) {
      return {
        tools: ["chief_project_chief", "chief_roster"],
        skills: ["chief"],
        instructions:
          "You are Chief — the Captain's only conversation, and the single Chief for every project. Delegate whole projects to project chiefs; never work a task yourself.",
      };
    }
    if (projectChiefThreads.has(context.thread.id)) {
      return {
        tools: ["chief_handoff", "chief_roster"],
        skills: ["project-chief"],
        instructions: `You are the project chief for ${context.project.name}. You report to Chief; the Captain is not in this thread.`,
      };
    }
    if (architectThreads.has(context.thread.id)) {
      return { tools: ["chief_roster"], skills: ["chief-architect"] };
    }
    return { tools: [], skills: [] };
  });

  // --------------------------------------------------------------------- cli

  // A plugin gets one CLI command, so Chief's surface is handed back to
  // the host module and mounted under `bb inbox chief …`.
  const chiefCli = {
    name: "chief",
    summary:
      "The Chief org: one global Chief, a project chief per project, task architects beneath them",
    commands: [
      {
        name: "status",
        summary:
          "Chief, every project chief, their task architects with live status, and everything waiting on the Captain.",
        usage: "bb chief status [--project <proj-id>] [--json]",
      },
      {
        name: "start",
        summary:
          "Create the single global Chief thread (bootstrapped with the one-word Chief trigger) if it does not exist.",
        usage: "bb chief start [--json]",
      },
      {
        name: "adopt",
        summary: "Register an existing thread as the global Chief.",
        usage: "bb chief adopt --thread thr_abc",
      },
      {
        name: "project-chief",
        summary:
          "Stand up the project chief for a project with a charter. Chief's move; same as the chief_project_chief tool.",
        usage:
          'bb chief project-chief --project proj_abc --charter "What this chief owns…" [--json]',
      },
      {
        name: "adopt-project-chief",
        summary:
          "Register an existing thread as the project chief for its project, without spawning anything. The project-chief counterpart of `adopt`.",
        usage:
          'bb chief adopt-project-chief --thread thr_abc [--charter "What this chief owns…"] [--json]',
      },
      {
        name: "handoff",
        summary:
          "Hand an existing BB task to a new task architect with a full brief. Same as the chief_handoff tool, for providers without native tools.",
        usage:
          'bb chief handoff --task BBC-12 --title "Ship the nav" --mission "…" [--criteria "…"]... [--constraint "…"]... [--context "…"] [--workspace worktree|project-default] [--project <proj-id>] [--json]',
      },
      {
        name: "retire",
        summary:
          "Mark an architect or project chief thread finished so it drops out of the active rail.",
        usage: "bb chief retire <thread-id> [--undo]",
      },
      {
        name: "tidy",
        summary:
          "Hide subordinate threads from the sidebar tree (they stay in this panel, on their tasks, and openable by id). Defaults to everything this plugin registered; --parent sweeps any thread's children instead. --undo puts them back.",
        usage:
          "bb chief tidy [--parent <thread-id>] [--recursive] [--undo] [--json]",
      },
    ],
    // Explicitly typed: outside bb.cli.register there is no contextual type.
    async run(
      argv: string[],
      ctx: PluginCliContext,
    ): Promise<PluginCliResult> {
      const [command = "status", ...rest] = argv;
      const args = parseArgs(rest);
      const json = args.bool("json");
      const ok = (text: string, data: unknown) => ({
        exitCode: 0,
        stdout: json ? `${JSON.stringify(data, null, 2)}\n` : text,
      });
      const fail = (message: string) => ({
        exitCode: 1,
        stderr: `${message}\n`,
      });

      switch (command) {
        case "status": {
          const { chief, groups, projects } = await roster();
          const inbox = await needsInput();
          const scope = args.one("project");
          const shown = scope
            ? groups.filter((group) => group.projectId === scope)
            : groups;
          const lines = [
            `Chief: ${chief ? `${chief.threadId} [${chief.status}]` : "not started (bb chief start)"}`,
          ];
          if (shown.length === 0) lines.push("Project chiefs: none");
          for (const group of shown) {
            lines.push(
              `${group.projectName}  ${group.chief.threadId} [${group.chief.status}]`,
            );
            for (const architect of group.architects) {
              lines.push(
                `    ${architect.taskKey ?? "(no task)"}  ${architect.title}  [${
                  architect.status
                }${architect.retired ? ", retired" : ""}]  ${architect.threadId}`,
              );
            }
          }
          lines.push(
            inbox.items.length === 0
              ? "Waiting on the Captain: nothing"
              : `Waiting on the Captain: ${inbox.items.length}`,
          );
          for (const item of inbox.items) {
            lines.push(`  ${item.id}  ${item.question}`);
          }
          return ok(`${lines.join("\n")}\n`, {
            chief,
            groups: shown,
            projects,
            needsInput: inbox.items,
          });
        }

        case "start": {
          const result = await ensureChief();
          return ok(
            `${result.created ? "Started Chief:" : "Chief already running:"} ${result.threadId}\n`,
            result,
          );
        }

        case "adopt": {
          const threadId = args.one("thread") ?? args.positional[0];
          if (!threadId) return fail("adopt needs --thread <thread-id>");
          const thread = await bb.sdk.threads.get({ threadId });
          recordChief(threadId, thread.projectId);
          return ok(`Chief is now ${threadId}.\n`, { threadId });
        }

        case "project-chief": {
          const projectId = args.one("project") ?? ctx.projectId;
          const charter = args.one("charter");
          if (!projectId) return fail("needs --project <proj-id>");
          if (!charter) return fail('needs --charter "<what this chief owns>"');
          const result = await ensureProjectChief({ projectId, charter });
          return ok(
            `${result.created ? "Started" : "Already running:"} project chief ${result.threadId} for ${projectId}\n`,
            result,
          );
        }

        case "adopt-project-chief": {
          const threadId = args.one("thread") ?? args.positional[0];
          if (!threadId) {
            return fail("adopt-project-chief needs --thread <thread-id>");
          }
          let thread;
          try {
            thread = await bb.sdk.threads.get({ threadId });
          } catch {
            return fail(`no such thread ${threadId}`);
          }
          const projectId = thread.projectId;
          if (!projectId) {
            return fail(`thread ${threadId} belongs to no project`);
          }
          const asked = args.one("project");
          if (asked && asked !== projectId) {
            return fail(
              `thread ${threadId} lives in ${projectId}, not ${asked} — a chief owns the project its thread is in`,
            );
          }
          // Replacing a live registered chief would orphan it silently, and a
          // second chief on one project is actively harmful, so make it explicit.
          const current = projectChiefRow(projectId);
          if (
            current &&
            current.thread_id !== threadId &&
            (await statusOf(current.thread_id)) &&
            !args.bool("force")
          ) {
            return fail(
              `${projectId} already has a live project chief ${current.thread_id}. Re-run with --force to point the registry at ${threadId} instead.`,
            );
          }
          const charter =
            args.one("charter") ??
            current?.charter ??
            `Adopted existing project chief thread ${threadId}.`;
          recordProjectChief(projectId, threadId, charter);
          bb.log.info(`project chief ${threadId} adopted for ${projectId}`);
          return ok(
            `Project chief for ${projectId} is now ${threadId}.\n`,
            { threadId, projectId, charter, created: false },
          );
        }

        case "handoff": {
          const taskKey = args.one("task");
          const title = args.one("title");
          const mission = args.one("mission");
          if (!taskKey || !title || !mission) {
            return fail(
              'handoff needs --task <key>, --title "<short title>" and --mission "<the brief>"',
            );
          }
          const workspace = args.one("workspace");
          if (
            workspace &&
            workspace !== "worktree" &&
            workspace !== "project-default"
          ) {
            return fail("--workspace must be worktree or project-default");
          }
          const result = await handoff(
            {
              taskKey,
              title,
              mission,
              successCriteria: args.all("criteria"),
              constraints: args.all("constraint"),
              context: args.one("context"),
              projectId: args.one("project"),
              environment: workspace as
                | "worktree"
                | "project-default"
                | undefined,
            },
            ctx.threadId ?? null,
          );
          return ok(
            `Handed ${taskKey} to ${result.threadId}.\n` +
              `Attach it: bb tasks attach ${taskKey} --thread ${result.threadId}\n`,
            { taskKey, ...result },
          );
        }

        case "retire": {
          const threadId = args.positional[0];
          if (!threadId) return fail("retire needs a thread id");
          const value = args.bool("undo") ? 0 : 1;
          const changed =
            db
              .prepare(`UPDATE architects SET retired = ? WHERE thread_id = ?`)
              .run(value, threadId).changes +
            db
              .prepare(
                `UPDATE project_chiefs SET retired = ? WHERE thread_id = ?`,
              )
              .run(value, threadId).changes;
          reloadRoles();
          publish();
          if (changed === 0) return fail(`no registered thread ${threadId}`);
          return ok(
            `${value === 1 ? "Retired" : "Restored"} ${threadId}.\n`,
            { threadId, retired: value === 1 },
          );
        }

        case "tidy": {
          const visibility = args.bool("undo") ? "visible" : "hidden";
          const parent = args.one("parent");
          const recursive = args.bool("recursive");

          /** Children of one thread, optionally the whole subtree below it. */
          const descendants = async (rootId: string) => {
            const found: string[] = [];
            const queue = [rootId];
            const seen = new Set<string>([rootId]);
            while (queue.length > 0) {
              const current = queue.shift()!;
              const threads = await bb.sdk.threads.list({
                parentThreadId: current,
                includeHidden: true,
                limit: 200,
              });
              for (const child of threads) {
                if (seen.has(child.id)) continue;
                seen.add(child.id);
                found.push(child.id);
                if (recursive) queue.push(child.id);
              }
            }
            return found;
          };

          const targets = parent
            ? await descendants(parent)
            : [
                // Chief itself is part of the default sweep: the panel is its
                // entry point, so it does not need a sidebar row either.
                ...(chiefThreadId ? [chiefThreadId] : []),
                ...(
                  db
                    .prepare(`SELECT thread_id FROM project_chiefs`)
                    .all() as { thread_id: string }[]
                ).map((row) => row.thread_id),
                ...(
                  db.prepare(`SELECT thread_id FROM architects`).all() as {
                    thread_id: string;
                  }[]
                ).map((row) => row.thread_id),
              ];

          const changed: string[] = [];
          const failed: { threadId: string; error: string }[] = [];
          for (const threadId of targets) {
            try {
              await bb.sdk.threads.update({ threadId, visibility });
              changed.push(threadId);
            } catch (error) {
              failed.push({ threadId, error: String(error) });
            }
          }
          publish();
          const undoParent = parent ? ` --parent ${parent}` : "";
          return ok(
            targets.length === 0
              ? "Nothing to tidy.\n"
              : `${visibility === "hidden" ? "Hid" : "Restored"} ${changed.length} of ${targets.length} thread(s).` +
                  (failed.length > 0 ? ` ${failed.length} failed.` : "") +
                  `\nUndo: bb chief tidy${undoParent}${recursive ? " --recursive" : ""} --undo\n`,
            { visibility, changed, failed },
          );
        }

        default:
          return fail(
            `unknown command "${command}". Try: status, start, adopt, project-chief, adopt-project-chief, handoff, retire, tidy`,
          );
      }
    },
  };

  bb.log.info("chief ready");
  return {
    cli: chiefCli,
    /** The one global Chief thread, for the request dispatcher. */
    chiefThreadId: () => chiefRow()?.thread_id ?? null,
  };
}

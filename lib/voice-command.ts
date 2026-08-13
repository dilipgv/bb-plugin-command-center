/**
 * Spoken command grammar for the command center.
 *
 * Speech is not typing: people say the work first and the metadata last
 * ("bump the MCP SDK, high priority, dispatch"), and they do not pause for
 * commas reliably. So modifiers are only ever consumed from the EDGES of the
 * utterance — a whole comma segment that is nothing but a modifier, or a
 * trailing/leading phrase. A modifier word sitting inside the sentence stays
 * part of the title, which is what keeps "fix the urgent care banner" intact.
 *
 * Pure functions only: no plugin API, no DOM. Exercisable from the CLI with
 * `bb inbox voice-parse "<transcript>"`.
 */

export interface VoiceProject {
  id: string;
  name: string;
}

export type VoicePriority = "low" | "normal" | "high";

export interface ParsedVoiceCommand {
  transcript: string;
  title: string;
  body: string;
  priority: VoicePriority;
  urgent: boolean;
  projectId: string | null;
  projectName: string | null;
  /** What the speaker asked for. Dispatch still needs a confirming click. */
  intent: "queue" | "dispatch";
  /** Human-readable list of everything extracted, for UI confirmation. */
  understood: string[];
}

const HIGH_PRIORITY =
  /^(?:high(?:est)? priority|priority high|top priority|important)$/;
const LOW_PRIORITY = /^(?:low priority|priority low|no rush|whenever|someday)$/;
const URGENT =
  /^(?:urgent|urgent!|asap|as soon as possible|right away|emergency|drop everything)$/;
const DISPATCH =
  /^(?:dispatch|dispatch it|dispatch it now|dispatch now|send it to chief|send to chief|hand it to chief|hand to chief|tell chief|give it to chief)$/;
const QUEUE = /^(?:queue|queue it|just queue it|queue only|hold it|later)$/;
const PROJECT_SEGMENT = /^(?:in|for|on|under|project)\s+(?:the\s+)?(.+?)(?:\s+project)?$/;

/** Openers people use before the actual work. */
const LEAD_IN =
  /^(?:(?:please|hey|ok|okay|alright)\s+)?(?:can you|could you|i(?:'| a)?d like you to|i need(?: you)? to|we need to|let's|lets|remind me to|note to self(?:\s*[:,])?|note that|make a note to)\s+/;
/**
 * A queue verb, not the work itself. "add" only counts as a command when it is
 * followed by a task noun — otherwise "add caching to the graph endpoint" loses
 * its verb and becomes "caching to the graph endpoint".
 */
const LEAD_VERB =
  /^(?:please\s+)?(?:queue(?:\s+up)?(?:\s+(?:a|an|the)\s+(?:task|request|item|todo|ticket|card))?|(?:add|create|new|log|file|open)\s+(?:a|an|the)?\s*(?:task|request|item|todo|ticket|card))\s*(?:to|for|that|which|saying)?\s*[:,]?\s*/;
const LEAD_DISPATCH =
  /^(?:please\s+)?(?:dispatch|send to chief|send this to chief|hand to chief)\s+(?:a|an|the)?\s*(?:task|request|item)?\s*(?:to|for|that)?\s*[:,]?\s*/;

/**
 * A marker that splits the title from its detail, WITH punctuation — which is
 * how it arrives when the speaker pauses and the transcriber obliges.
 */
const BODY_MARKER = /\b(?:details?|context|notes?|background)\s*[:,-]\s+/iu;

/**
 * The same marker with no punctuation at all: dictation usually returns
 * "look into the leak details only happens after a long session" flat, so
 * requiring a colon meant the detail silently stayed in the title.
 *
 * Unpunctuated splitting is genuinely ambiguous ("update the notes page"), and
 * a wrongly split title is worse than a detail the user moves by hand, so it
 * takes two guards: the marker may not be preceded by a determiner or a word
 * that makes it a noun phrase, and what follows must be long enough to be a
 * clause rather than the rest of a phrase.
 */
const BARE_BODY_MARKER = /\b(details?|context|notes?|background)\s+/giu;
const MIN_BARE_DETAIL_WORDS = 4;
const NOUN_PHRASE_BEFORE = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "your",
  "its",
  "their",
  "his",
  "her",
  "these",
  "those",
  "some",
  "more",
  "all",
  "any",
  "no",
  "release",
  "additional",
  "further",
  "extra",
  "other",
  "same",
  "full",
  "api",
  "product",
  "design",
]);

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/** Split a title into title + detail, or return null to leave it alone. */
function splitDetail(title: string): { title: string; body: string } | null {
  const punctuated = BODY_MARKER.exec(title);
  if (punctuated !== null && punctuated.index > 0) {
    return {
      title: title.slice(0, punctuated.index).trim(),
      body: title.slice(punctuated.index + punctuated[0].length).trim(),
    };
  }

  BARE_BODY_MARKER.lastIndex = 0;
  for (
    let match = BARE_BODY_MARKER.exec(title);
    match !== null;
    match = BARE_BODY_MARKER.exec(title)
  ) {
    const before = title.slice(0, match.index).trim();
    const after = title.slice(match.index + match[0].length).trim();
    if (before === "" || wordCount(after) < MIN_BARE_DETAIL_WORDS) continue;
    const precedingWord = before
      .replace(/[^\p{L}\p{N}\s]+$/u, "")
      .split(/\s+/u)
      .pop();
    if (
      precedingWord !== undefined &&
      NOUN_PHRASE_BEFORE.has(precedingWord.toLowerCase())
    ) {
      continue;
    }
    return {
      title: before.replace(/[\s,;.]+$/u, ""),
      // "note that X" reads better as just X.
      body: after.replace(/^that\s+/iu, ""),
    };
  }
  return null;
}

const YES_WORDS = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "approve",
  "approved",
  "approval",
  "lgtm",
  "ship",
  "ship it",
  "ship now",
  "do it",
  "go ahead",
  "confirm",
  "confirmed",
  "correct",
  "right",
];

const NO_WORDS = [
  "no",
  "nope",
  "nah",
  "negative",
  "reject",
  "rejected",
  "decline",
  "needs changes",
  "needs work",
  "not yet",
  "wait",
  "hold",
  "hold off",
  "stop",
  "cancel",
];

export function normalizeSpeech(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

/** Lowercase, drop punctuation, collapse spaces — for comparisons only. */
function comparable(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function capitalizeFirst(text: string): string {
  if (text.length === 0) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function resolveProject(
  spoken: string,
  projects: readonly VoiceProject[],
): VoiceProject | null {
  const said = comparable(spoken);
  if (said === "") return null;
  let best: { project: VoiceProject; score: number } | null = null;
  for (const project of projects) {
    const name = comparable(project.name);
    if (name === "") continue;
    let score = 0;
    if (name === said) score = 1;
    else if (said.includes(name) || name.includes(said)) score = 0.8;
    else {
      const nameTokens = name.split(" ");
      const saidTokens = new Set(said.split(" "));
      const hits = nameTokens.filter((token) => saidTokens.has(token)).length;
      score = nameTokens.length > 0 ? (hits / nameTokens.length) * 0.7 : 0;
    }
    // Longer names win ties: "bb server" beats "bb" on the same utterance.
    if (score >= 0.6 && (best === null || score > best.score)) {
      best = { project, score };
    }
  }
  return best?.project ?? null;
}

/**
 * Project matching for a phrase that is supposed to be *only* a project name.
 *
 * Deliberately asymmetric: a short spoken fragment may name a longer project
 * ("mcp micros" → "atlassian-mcp-micros"), but a long phrase that merely
 * contains a project name is not a project reference — otherwise
 * "in ecosystem add caching to the graph endpoint" is consumed whole and the
 * title comes out empty.
 */
function scoreProjectStrict(
  spoken: string,
  projects: readonly VoiceProject[],
): { project: VoiceProject; score: number } | null {
  const said = comparable(spoken);
  if (said === "") return null;
  let best: { project: VoiceProject; score: number } | null = null;
  for (const project of projects) {
    const name = comparable(project.name);
    if (name === "") continue;
    let score = 0;
    if (name === said) score = 1;
    else if (name.includes(said) && said.length >= 3) score = 0.8;
    else if (said.includes(name) && said.length <= name.length * 1.3) {
      score = 0.7;
    }
    if (score > 0 && (best === null || score > best.score)) {
      best = { project, score };
    }
  }
  return best;
}

function resolveProjectStrict(
  spoken: string,
  projects: readonly VoiceProject[],
): VoiceProject | null {
  return scoreProjectStrict(spoken, projects)?.project ?? null;
}

/**
 * "in <project> <the actual work>" — consume only the project name. Tries the
 * longest leading token run first so multi-word project names win.
 */
function matchLeadingProject(
  text: string,
  projects: readonly VoiceProject[],
): { project: VoiceProject; rest: string } | null {
  const lead = /^(?:in|for|on|under)\s+(?:the\s+)?(.+)$/iu.exec(text);
  if (lead?.[1] === undefined) return null;
  const remainder = lead[1];
  const tokens = remainder.split(/\s+/u);
  // Score every candidate length and take the best match, longest on a tie —
  // an exact one-token hit must beat a sloppy two-token one that has swallowed
  // the first word of the actual work.
  let best: { project: VoiceProject; score: number; count: number } | null =
    null;
  for (let count = 1; count <= Math.min(6, tokens.length); count += 1) {
    const candidate = tokens
      .slice(0, count)
      .join(" ")
      .replace(/\s+project$/iu, "");
    const scored = scoreProjectStrict(candidate, projects);
    if (scored === null) continue;
    if (best === null || scored.score > best.score) {
      best = { project: scored.project, score: scored.score, count };
    }
  }
  if (best === null) return null;
  const rest = tokens
    .slice(best.count)
    .join(" ")
    .replace(/^(?:project)\s+/iu, "")
    .replace(/^[,;:]\s*/u, "")
    .trim();
  // A bare "in <project>" with no work left is a modifier, not a title.
  return rest === "" ? null : { project: best.project, rest };
}

interface Accumulator {
  priority: VoicePriority;
  urgent: boolean;
  project: VoiceProject | null;
  intent: "queue" | "dispatch";
}

/** A whole comma segment that carries only metadata. Returns false if not. */
function consumeModifierSegment(
  segment: string,
  accumulator: Accumulator,
  projects: readonly VoiceProject[],
): boolean {
  const value = comparable(segment);
  if (value === "") return true;
  if (HIGH_PRIORITY.test(value)) {
    accumulator.priority = "high";
    return true;
  }
  if (LOW_PRIORITY.test(value)) {
    accumulator.priority = "low";
    return true;
  }
  if (URGENT.test(value)) {
    accumulator.urgent = true;
    return true;
  }
  if (DISPATCH.test(value)) {
    accumulator.intent = "dispatch";
    return true;
  }
  if (QUEUE.test(value)) {
    accumulator.intent = "queue";
    return true;
  }
  const projectMatch = PROJECT_SEGMENT.exec(value);
  if (projectMatch?.[1] !== undefined) {
    const project = resolveProjectStrict(projectMatch[1], projects);
    if (project !== null) {
      accumulator.project = project;
      return true;
    }
  }
  return false;
}

/**
 * Strip metadata the speaker tacked on without pausing. Runs until nothing
 * changes, so "…, high priority and dispatch it" fully unwinds.
 */
function stripTrailingModifiers(
  title: string,
  accumulator: Accumulator,
  projects: readonly VoiceProject[],
): string {
  let current = title;
  for (let pass = 0; pass < 6; pass += 1) {
    const before = current;
    current = current.replace(
      /[\s,;]*(?:and\s+)?(?:please\s+)?(?:then\s+)?dispatch(?:\s+it)?(?:\s+now)?[.!]?$/iu,
      () => {
        accumulator.intent = "dispatch";
        return "";
      },
    );
    current = current.replace(
      /[\s,;]*(?:and\s+)?(?:send|hand)\s+(?:it\s+)?to\s+chief[.!]?$/iu,
      () => {
        accumulator.intent = "dispatch";
        return "";
      },
    );
    current = current.replace(
      /[\s,;]*(?:and\s+)?(?:this\s+is\s+|it'?s\s+)?urgent[.!]?$/iu,
      () => {
        accumulator.urgent = true;
        return "";
      },
    );
    current = current.replace(
      /[\s,;]*(?:and\s+)?(?:at\s+|as\s+)?high(?:est)? priority[.!]?$/iu,
      () => {
        accumulator.priority = "high";
        return "";
      },
    );
    current = current.replace(
      /[\s,;]*(?:and\s+)?(?:at\s+|as\s+)?low priority[.!]?$/iu,
      () => {
        accumulator.priority = "low";
        return "";
      },
    );
    // Only consume a trailing "in <x>" when <x> is a project that exists.
    const projectTail =
      /[\s,;]*(?:in|for|on|under)\s+(?:the\s+)?([\p{L}\p{N}\s'’-]+?)(?:\s+project)?[.!]?$/u.exec(
        current,
      );
    if (projectTail?.[1] !== undefined) {
      const project = resolveProjectStrict(projectTail[1], projects);
      if (project !== null && projectTail.index > 0) {
        accumulator.project = project;
        current = current.slice(0, projectTail.index);
      }
    }
    current = current.trim();
    if (current === before.trim()) break;
  }
  return current;
}

export function parseVoiceCommand(
  rawTranscript: string,
  projects: readonly VoiceProject[] = [],
): ParsedVoiceCommand {
  const transcript = normalizeSpeech(rawTranscript);
  const accumulator: Accumulator = {
    priority: "normal",
    urgent: false,
    project: null,
    intent: "queue",
  };

  // Leading "urgent:" / "urgent," before the work itself.
  let working = transcript.replace(
    /^(?:urgent|asap|emergency)\s*[:,-]\s+/iu,
    () => {
      accumulator.urgent = true;
      return "";
    },
  );
  working = working.replace(/^(?:high priority)\s*[:,-]\s+/iu, () => {
    accumulator.priority = "high";
    return "";
  });

  const kept: string[] = [];
  for (const segment of working.split(/[,;]|\s+\band then\b\s+/u)) {
    if (!consumeModifierSegment(segment, accumulator, projects)) {
      kept.push(segment.trim());
    }
  }

  let title = kept.filter((segment) => segment !== "").join(", ");
  title = title.replace(LEAD_IN, "");
  const dispatchLead = LEAD_DISPATCH.exec(title);
  if (dispatchLead !== null) {
    accumulator.intent = "dispatch";
    title = title.slice(dispatchLead[0].length);
  } else {
    title = title.replace(LEAD_VERB, "");
  }

  // "in <project>, <work>" — the project leads, the work follows.
  const leadingProject = matchLeadingProject(title.trim(), projects);
  if (leadingProject !== null) {
    accumulator.project = leadingProject.project;
    title = leadingProject.rest;
    // The work may itself start with a verb: "in X add caching…".
    title = title.replace(LEAD_VERB, "");
  }

  title = stripTrailingModifiers(title.trim(), accumulator, projects);

  let body = "";
  const split = splitDetail(title);
  if (split !== null) {
    title = split.title;
    body = split.body;
  }

  title = capitalizeFirst(title.replace(/[\s,;.]+$/u, "").trim());

  const understood: string[] = [];
  if (accumulator.urgent) understood.push("urgent");
  if (accumulator.priority !== "normal") {
    understood.push(`${accumulator.priority} priority`);
  }
  if (accumulator.project !== null) {
    understood.push(`project: ${accumulator.project.name}`);
  }
  if (accumulator.intent === "dispatch") understood.push("dispatch");
  if (body !== "") understood.push("detail");

  return {
    transcript,
    title,
    body,
    priority: accumulator.priority,
    urgent: accumulator.urgent,
    projectId: accumulator.project?.id ?? null,
    projectName: accumulator.project?.name ?? null,
    intent: accumulator.intent,
    understood,
  };
}

// ------------------------------------------------------- spoken answers

export interface SpokenOptionMatch {
  option: string;
  confidence: number;
}

function alias(value: string): "yes" | "no" | null {
  if (YES_WORDS.includes(value)) return "yes";
  if (NO_WORDS.includes(value)) return "no";
  return null;
}

function scoreOption(said: string, option: string): number {
  const target = comparable(option);
  if (target === "" || said === "") return 0;
  if (said === target) return 1;

  const saidAlias = alias(said);
  const targetAlias = alias(target);
  if (saidAlias !== null && targetAlias !== null) {
    return saidAlias === targetAlias ? 0.85 : 0;
  }

  if (said.includes(target)) return 0.9;
  if (target.includes(said) && said.length >= 3) return 0.75;

  const targetTokens = target.split(" ");
  const saidTokens = new Set(said.split(" "));
  const hits = targetTokens.filter((token) => saidTokens.has(token)).length;
  return targetTokens.length > 0 ? (hits / targetTokens.length) * 0.7 : 0;
}

/**
 * Best single option for an utterance. Returns null when nothing clears the
 * bar or when two options tie — a coin flip on the user's behalf is worse
 * than asking them to tap.
 */
export function matchSpokenOption(
  transcript: string,
  options: readonly string[],
): SpokenOptionMatch | null {
  const said = comparable(transcript);
  const scored = options
    .map((option) => ({ option, confidence: scoreOption(said, option) }))
    .filter((entry) => entry.confidence >= 0.5)
    .sort((left, right) => right.confidence - left.confidence);

  const best = scored[0];
  if (best === undefined) return null;
  const runnerUp = scored[1];
  if (runnerUp !== undefined && runnerUp.confidence === best.confidence) {
    return null;
  }
  return best;
}

/** Every option the utterance mentions, for multi-select questions. */
export function matchSpokenOptions(
  transcript: string,
  options: readonly string[],
): string[] {
  const said = comparable(transcript);
  return options.filter((option) => {
    const target = comparable(option);
    return target !== "" && (said.includes(target) || scoreOption(said, option) >= 0.7);
  });
}

/**
 * Artifacts a card produced: the pull request, the Confluence page, the link you
 * asked for.
 *
 * There is no integration to ask — agents paste these into task comments, the
 * question text, or a request's outcome. So the artifacts are mined out of the
 * prose the card already carries, which means the card shows the thing you asked
 * for without anyone having to remember to attach it.
 *
 * Pure functions: no plugin API, no DOM.
 */

export type ArtifactKind =
  | "pull-request"
  | "confluence"
  | "jira"
  | "link";

export interface Artifact {
  kind: ArtifactKind;
  url: string;
  /** Short human label: "PR #412", "Confluence page", "MCP-1443". */
  label: string;
}

/** Markdown link syntax, bare URLs, and angle-bracketed URLs all appear. */
const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/giu;

/** Trailing punctuation that belongs to the sentence, not the URL. */
const TRAILING_JUNK = /[.,;:!?)\]}>'"`*]+$/u;

const GITHUB_PR = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/iu;
const BITBUCKET_PR = /bitbucket\.org\/[^/]+\/[^/]+\/pull-requests\/(\d+)/iu;
const CONFLUENCE = /atlassian\.net\/wiki\//iu;
const CONFLUENCE_SHORT = /atlassian\.net\/l\/c/iu;
const JIRA_BROWSE = /atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/iu;

/**
 * Name a Confluence link by what it actually is. Several links on one card all
 * reading "Confluence page" tell you nothing, and the page title is usually
 * sitting right there in the path.
 */
function confluenceLabel(url: string): string {
  if (/resumedraft\.action/iu.test(url)) return "Confluence draft";
  const titled = /\/wiki\/spaces\/[^/]+\/pages\/\d+\/([^/?#]+)/iu.exec(url);
  if (titled?.[1] !== undefined) {
    const title = decodeURIComponent(titled[1]).replace(/[+_-]+/gu, " ").trim();
    if (title !== "") return title.length > 42 ? `${title.slice(0, 41)}…` : title;
  }
  const space = /\/wiki\/spaces\/([^/?#]+)/iu.exec(url);
  if (space?.[1] !== undefined) return `Confluence: ${space[1]}`;
  return "Confluence page";
}

function classify(url: string): Artifact {
  const github = GITHUB_PR.exec(url);
  if (github?.[1] !== undefined) {
    return { kind: "pull-request", url, label: `PR #${github[1]}` };
  }
  const bitbucket = BITBUCKET_PR.exec(url);
  if (bitbucket?.[1] !== undefined) {
    return { kind: "pull-request", url, label: `PR #${bitbucket[1]}` };
  }
  const jira = JIRA_BROWSE.exec(url);
  if (jira?.[1] !== undefined) {
    return { kind: "jira", url, label: jira[1].toUpperCase() };
  }
  if (CONFLUENCE.test(url) || CONFLUENCE_SHORT.test(url)) {
    return { kind: "confluence", url, label: confluenceLabel(url) };
  }
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    // Keep the raw string; a malformed URL is still worth showing.
  }
  return { kind: "link", url, label: host };
}

const KIND_ORDER: Record<ArtifactKind, number> = {
  "pull-request": 0,
  confluence: 1,
  jira: 2,
  link: 3,
};

/**
 * Every distinct URL across the given texts, most interesting kind first.
 * Deduplicated on the URL, so a link repeated in five comments appears once.
 */
export function extractArtifacts(
  texts: readonly (string | null | undefined)[],
  limit = 12,
): Artifact[] {
  const found = new Map<string, Artifact>();
  for (const text of texts) {
    if (text === null || text === undefined || text === "") continue;
    URL_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      const raw = match[0].replace(TRAILING_JUNK, "");
      if (raw.length < 12) continue;
      if (!found.has(raw)) found.set(raw, classify(raw));
    }
  }
  return Array.from(found.values())
    .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind])
    .slice(0, limit);
}

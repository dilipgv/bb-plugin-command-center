/**
 * A one-line plain-text preview of a Markdown body, for a collapsed section's
 * header. You should be able to scan twenty collapsed updates and know which one
 * to open, which means the header has to carry the first real sentence — not
 * "## Stage 2 complete" with its syntax still attached.
 */

/** Fence bodies are code, not prose; never preview from inside one. */
const FENCE = /^\s*(?:```|~~~)/u;

function stripInline(line: string): string {
  return line
    // Images before links: ![alt](src) would otherwise leave a stray "!".
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/gu, "$1")
    .replace(/(\*\*|__)(.*?)\1/gu, "$2")
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/gu, "$2")
    .replace(/~~(.*?)~~/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function previewMarkdown(body: string, maxChars = 96): string {
  let inFence = false;
  for (const rawLine of body.split("\n")) {
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = rawLine
      // Leading block syntax: heading, quote, list marker, table pipe.
      .replace(/^\s{0,3}#{1,6}\s+/u, "")
      .replace(/^\s{0,3}>\s?/u, "")
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/u, "")
      .replace(/^\s*\|/u, "")
      .trim();
    if (line === "") continue;
    // A table rule or horizontal rule carries no meaning on its own.
    if (/^[-|:\s]+$/u.test(line) || /^(?:\*\s*){3,}$/u.test(line)) continue;

    const text = stripInline(line);
    if (text === "") continue;
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }
  return "";
}

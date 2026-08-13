/**
 * Keyboard shortcuts owned by this plugin.
 *
 * BB's own keybinding settings accept a closed enum of built-in commands, so a
 * plugin cannot register there. These are parsed from plugin settings instead,
 * which is what makes them user-editable:
 *
 *   bb plugin config inbox set detailShortcut "alt+d"
 *
 * Matching uses `event.code` for letters and digits, not `event.key`: on macOS
 * ⌥D emits "∂" and ⌥V emits "√", so a key-based comparison silently fails for
 * exactly the Alt combinations that make good plugin shortcuts.
 */

export interface Shortcut {
  code: string | null;
  key: string | null;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

const IS_APPLE =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/iu.test(navigator.platform || navigator.userAgent);

const NAMED_KEYS: Record<string, string> = {
  space: "Space",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  slash: "Slash",
  period: "Period",
  comma: "Comma",
};

/** Parses "alt+d", "mod+shift+k", "ctrl+alt+space". Null when unusable. */
export function parseShortcut(spec: string): Shortcut | null {
  const tokens = spec
    .toLowerCase()
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return null;

  const shortcut: Shortcut = {
    code: null,
    key: null,
    alt: false,
    shift: false,
    meta: false,
    ctrl: false,
  };

  for (const token of tokens) {
    switch (token) {
      case "alt":
      case "opt":
      case "option":
        shortcut.alt = true;
        continue;
      case "shift":
        shortcut.shift = true;
        continue;
      case "ctrl":
      case "control":
        shortcut.ctrl = true;
        continue;
      case "cmd":
      case "command":
      case "meta":
      case "super":
        shortcut.meta = true;
        continue;
      case "mod":
        if (IS_APPLE) shortcut.meta = true;
        else shortcut.ctrl = true;
        continue;
      default:
        break;
    }

    if (/^[a-z]$/u.test(token)) {
      shortcut.code = `Key${token.toUpperCase()}`;
    } else if (/^[0-9]$/u.test(token)) {
      shortcut.code = `Digit${token}`;
    } else if (NAMED_KEYS[token] !== undefined) {
      shortcut.code = NAMED_KEYS[token];
    } else {
      shortcut.key = token;
    }
  }

  if (shortcut.code === null && shortcut.key === null) return null;
  // A bare letter with no modifier would fire while typing.
  if (!shortcut.alt && !shortcut.ctrl && !shortcut.meta) return null;
  return shortcut;
}

export interface ShortcutEvent {
  code: string;
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export function matchesShortcut(
  event: ShortcutEvent,
  shortcut: Shortcut,
): boolean {
  if (event.altKey !== shortcut.alt) return false;
  if (event.shiftKey !== shortcut.shift) return false;
  if (event.metaKey !== shortcut.meta) return false;
  if (event.ctrlKey !== shortcut.ctrl) return false;
  if (shortcut.code !== null) return event.code === shortcut.code;
  return event.key.toLowerCase() === shortcut.key;
}

/** "⌥D" on Apple platforms, "Alt+D" elsewhere. */
export function formatShortcut(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push(IS_APPLE ? "⌃" : "Ctrl");
  if (shortcut.alt) parts.push(IS_APPLE ? "⌥" : "Alt");
  if (shortcut.shift) parts.push(IS_APPLE ? "⇧" : "Shift");
  if (shortcut.meta) parts.push(IS_APPLE ? "⌘" : "Meta");

  let label = shortcut.key ?? "";
  if (shortcut.code !== null) {
    if (shortcut.code.startsWith("Key")) label = shortcut.code.slice(3);
    else if (shortcut.code.startsWith("Digit")) label = shortcut.code.slice(5);
    else label = shortcut.code;
  }
  parts.push(label.length === 1 ? label.toUpperCase() : label);
  return parts.join(IS_APPLE ? "" : "+");
}

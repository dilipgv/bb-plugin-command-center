/**
 * Binds one plugin-owned shortcut to the panel while it is mounted.
 *
 * Deliberately listens on window and fires even while an input is focused —
 * these shortcuts exist so you never have to leave the keyboard — and calls
 * preventDefault so ⌥D does not type "∂" into the field you are in.
 */
import * as React from "react";

import {
  formatShortcut,
  matchesShortcut,
  parseShortcut,
  type Shortcut,
} from "@/lib/shortcut";

export function useShortcut(
  spec: string | undefined,
  handler: () => void,
  enabled = true,
): { shortcut: Shortcut | null; label: string | null } {
  const handlerRef = React.useRef(handler);
  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  const shortcut = React.useMemo(
    () => (spec === undefined ? null : parseShortcut(spec)),
    [spec],
  );

  React.useEffect(() => {
    if (shortcut === null || !enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, shortcut]);

  return {
    shortcut,
    label: shortcut === null ? null : formatShortcut(shortcut),
  };
}

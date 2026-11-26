// Page chords for the control tower. Ignored while typing or while a dialog is open.

const TYPABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TYPABLE.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  if (target.closest("[role='dialog'], [role='alertdialog']")) return true;
  return false;
}

export type Shortcut =
  | { type: "go"; to: "/" | "/waiting" | "/review" | "/specs" | "/metrics" }
  | { type: "search" }
  | { type: "help" };

export function shortcutFromKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
  pendingGo: boolean,
): { shortcut?: Shortcut; pendingGo: boolean } {
  if (event.metaKey || event.ctrlKey) {
    if (event.key === "k" || event.key === "K")
      return { shortcut: { type: "search" }, pendingGo: false };
    return { pendingGo: false };
  }
  if (event.key === "?")
    return { shortcut: { type: "help" }, pendingGo: false };
  if (pendingGo) {
    if (event.key === "h")
      return { shortcut: { type: "go", to: "/" }, pendingGo: false };
    if (event.key === "b")
      return { shortcut: { type: "go", to: "/waiting" }, pendingGo: false };
    if (event.key === "r")
      return { shortcut: { type: "go", to: "/review" }, pendingGo: false };
    if (event.key === "s")
      return { shortcut: { type: "go", to: "/specs" }, pendingGo: false };
    if (event.key === "m")
      return { shortcut: { type: "go", to: "/metrics" }, pendingGo: false };
    return { pendingGo: false };
  }
  if (event.key === "g") return { pendingGo: true };
  return { pendingGo: false };
}

export type ReviewShortcut =
  | { type: "next-file" }
  | { type: "prev-file" }
  | { type: "next-hunk" }
  | { type: "prev-hunk" }
  | { type: "toggle-viewed" }
  | { type: "focus-filter" }
  | { type: "comment" };

export function reviewShortcutFromKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
): ReviewShortcut | undefined {
  if (event.metaKey || event.ctrlKey) return undefined;
  if (event.key === "j") return { type: "next-file" };
  if (event.key === "k") return { type: "prev-file" };
  if (event.key === "n") return { type: "next-hunk" };
  if (event.key === "p") return { type: "prev-hunk" };
  if (event.key === "v") return { type: "toggle-viewed" };
  if (event.key === "/") return { type: "focus-filter" };
  if (event.key === "c") return { type: "comment" };
  return undefined;
}

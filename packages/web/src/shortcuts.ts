// Page chords for the control tower. Ignored while typing or while a dialog is open.

const TYPABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TYPABLE.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  if (target.closest("[role='dialog']")) return true;
  return false;
}

export type Shortcut =
  | { type: "go"; to: "/" | "/waiting" | "/specs" }
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
    if (event.key === "s")
      return { shortcut: { type: "go", to: "/specs" }, pendingGo: false };
    return { pendingGo: false };
  }
  if (event.key === "g") return { pendingGo: true };
  return { pendingGo: false };
}

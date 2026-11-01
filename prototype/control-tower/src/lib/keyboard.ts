export function shortcutDestination(prefix: string, key: string) {
  if (prefix !== "g") return undefined;
  return ({ h: "/", b: "/waiting", s: "/specs" } as const)[key as "h" | "b" | "s"];
}
export function isEditingTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable="true"],[role="combobox"],[role="textbox"]'));
}
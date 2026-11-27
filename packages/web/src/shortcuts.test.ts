// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isTypingTarget,
  reviewShortcutFromKey,
  shortcutFromKey,
} from "./shortcuts.ts";

describe("keyboard shortcuts", () => {
  it("maps g r to the review queue", () => {
    expect(
      shortcutFromKey({ key: "r", metaKey: false, ctrlKey: false }, true),
    ).toEqual({
      shortcut: { type: "go", to: "/review" },
      pendingGo: false,
    });
  });

  it("maps g h / g b / g s / g m, ⌘K and ?", () => {
    expect(
      shortcutFromKey({ key: "g", metaKey: false, ctrlKey: false }, false),
    ).toEqual({
      pendingGo: true,
    });
    expect(
      shortcutFromKey({ key: "h", metaKey: false, ctrlKey: false }, true),
    ).toEqual({
      shortcut: { type: "go", to: "/" },
      pendingGo: false,
    });
    expect(
      shortcutFromKey({ key: "b", metaKey: false, ctrlKey: false }, true),
    ).toEqual({
      shortcut: { type: "go", to: "/waiting" },
      pendingGo: false,
    });
    expect(
      shortcutFromKey({ key: "s", metaKey: false, ctrlKey: false }, true),
    ).toEqual({
      shortcut: { type: "go", to: "/specs" },
      pendingGo: false,
    });
    expect(
      shortcutFromKey({ key: "m", metaKey: false, ctrlKey: false }, true),
    ).toEqual({
      shortcut: { type: "go", to: "/metrics" },
      pendingGo: false,
    });
    expect(
      shortcutFromKey({ key: "k", metaKey: true, ctrlKey: false }, false),
    ).toEqual({
      shortcut: { type: "search" },
      pendingGo: false,
    });
    expect(
      shortcutFromKey({ key: "?", metaKey: false, ctrlKey: false }, false),
    ).toEqual({
      shortcut: { type: "help" },
      pendingGo: false,
    });
  });

  it("maps review-page j/k/n/p/v/c and / without turning them into go chords", () => {
    const keys = { metaKey: false, ctrlKey: false } as const;
    expect(reviewShortcutFromKey({ key: "j", ...keys })).toEqual({
      type: "next-file",
    });
    expect(reviewShortcutFromKey({ key: "k", ...keys })).toEqual({
      type: "prev-file",
    });
    expect(reviewShortcutFromKey({ key: "n", ...keys })).toEqual({
      type: "next-hunk",
    });
    expect(reviewShortcutFromKey({ key: "p", ...keys })).toEqual({
      type: "prev-hunk",
    });
    expect(reviewShortcutFromKey({ key: "v", ...keys })).toEqual({
      type: "toggle-viewed",
    });
    expect(reviewShortcutFromKey({ key: "/", ...keys })).toEqual({
      type: "focus-filter",
    });
    expect(reviewShortcutFromKey({ key: "c", ...keys })).toEqual({
      type: "comment",
    });
    expect(
      reviewShortcutFromKey({ key: "j", metaKey: true, ctrlKey: false }),
    ).toBeUndefined();
    expect(
      shortcutFromKey({ key: "j", ...keys }, false).shortcut,
    ).toBeUndefined();
  });

  it("treats an input or an open dialog as a typing target", () => {
    const input = document.createElement("input");
    expect(isTypingTarget(input)).toBe(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("span");
    dialog.append(inside);
    expect(isTypingTarget(inside)).toBe(true);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
  });
});

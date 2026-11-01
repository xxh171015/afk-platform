import type { InvalidatePayload } from "@afk/shared";

// In-process subscribers of GET /events. One API process, so a Set of listeners is enough
// (docs/specs/experience-platform.md「页面刷新」).

export type InvalidateListener = (payload: InvalidatePayload) => void;

export class EventsHub {
  private readonly listeners = new Set<InvalidateListener>();

  subscribe(listener: InvalidateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(payload: InvalidatePayload): void {
    for (const listener of this.listeners) listener(payload);
  }
}

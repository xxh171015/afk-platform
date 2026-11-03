// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EventsProvider } from "./EventsProvider.tsx";
import { queryKeysForInvalidate } from "./live.ts";

afterEach(() => {
  cleanup();
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    name: string,
    listener: (event: MessageEvent<string>) => void,
  ) {
    this.listeners.set(name, listener);
  }

  removeEventListener(name: string) {
    this.listeners.delete(name);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  fire(payload: object) {
    this.listeners.get("invalidate")?.({
      data: JSON.stringify(payload),
    } as MessageEvent<string>);
  }
}

describe("EventsProvider", () => {
  it("invalidates the query keys for an incoming invalidate event", async () => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const invalidated: unknown[] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((args?: {
      queryKey?: readonly unknown[];
    }) => {
      if (args?.queryKey) invalidated.push(args.queryKey);
      return original(args);
    }) as typeof queryClient.invalidateQueries;

    render(
      <QueryClientProvider client={queryClient}>
        <EventsProvider>
          <p>live</p>
        </EventsProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]?.url).toMatch(/\/events$/);
    FakeEventSource.instances[0]?.fire({ specId: 3, ticketId: 9 });
    await waitFor(() =>
      expect(invalidated).toEqual(
        queryKeysForInvalidate({ specId: 3, ticketId: 9 }),
      ),
    );
  });

  it("does not hold an EventSource while the tab is hidden", async () => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    const visibility = { state: "visible" };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility.state,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <EventsProvider>
          <p>live</p>
        </EventsProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    visibility.state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(FakeEventSource.instances[0]?.closed).toBe(true),
    );

    visibility.state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1]?.closed).toBe(false);
  });
});

import type { InvalidatePayload } from "@afk/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { apiBase } from "./api.tsx";
import { queryKeysForInvalidate, resourcePollMs } from "./live.ts";

interface LiveEvents {
  connected: boolean;
}

const EventsContext = createContext<LiveEvents | null>(null);

function parseInvalidate(data: string): InvalidatePayload | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    return parsed as InvalidatePayload;
  } catch {
    return undefined;
  }
}

export function EventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(`${apiBase()}/events`);
    const onInvalidate = (event: MessageEvent<string>) => {
      const payload = parseInvalidate(event.data);
      if (!payload) return;
      for (const queryKey of queryKeysForInvalidate(payload)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    source.addEventListener("invalidate", onInvalidate);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => {
      source.removeEventListener("invalidate", onInvalidate);
      source.close();
      setConnected(false);
    };
  }, [queryClient]);

  const value = useMemo(() => ({ connected }), [connected]);
  return (
    <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
  );
}

export function useEvents(): LiveEvents | null {
  return useContext(EventsContext);
}

export function useResourcePoll(disconnectedMs: number): number | false {
  const live = useEvents();
  if (!live) return false;
  return resourcePollMs(live.connected, disconnectedMs);
}

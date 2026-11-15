import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { describeError, useApi } from "../api.tsx";
import { useResourcePoll } from "../EventsProvider.tsx";
import { DETAIL_POLL_MS } from "../live.ts";

export const list = <T>(value: T[] | undefined | null): T[] =>
  Array.isArray(value) ? value : [];

export function useSpecView(specId: number) {
  const api = useApi();
  const poll = useResourcePoll(DETAIL_POLL_MS);
  return useQuery({
    queryKey: ["spec", specId],
    queryFn: async () => {
      const { data, error } = await api.GET("/specs/{id}", {
        params: { path: { id: specId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });
}

export type SpecView = NonNullable<ReturnType<typeof useSpecView>["data"]>;

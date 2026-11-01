import { useEffect, useState } from "react";
import { recordVisit, SEARCH_DEBOUNCE_MS, type RecentVisit } from "@/lib/search";

export function useDebouncedSearch(value: string) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(value.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return query;
}

export function useRecentVisit(visit: RecentVisit | undefined) {
  const key = visit ? JSON.stringify(visit) : "";
  useEffect(() => { if (key) recordVisit(JSON.parse(key) as RecentVisit); }, [key]);
}
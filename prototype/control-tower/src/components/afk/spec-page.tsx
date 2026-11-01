import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { specQuery } from "@/api/queries";

export function useSpecDetail() {
  const { id } = useParams({ from: "/specs/$id" });
  return useQuery(specQuery(id)).data;
}

export function specPageHead(id: string, section: string, description: string) {
  const title = `${section} · 需求 ${id} · AFK 平台`;
  return { meta: [
    { title }, { name: "description", content: description },
    { property: "og:title", content: title }, { property: "og:description", content: description },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] };
}
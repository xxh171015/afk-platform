import { createFileRoute } from "@tanstack/react-router";
import { SpecList } from "../../SpecList.tsx";

export const Route = createFileRoute("/specs/")({
  component: SpecList,
});

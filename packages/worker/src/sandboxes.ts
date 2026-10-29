import { sep } from "node:path";
import { exec } from "@afk/pipeline";

export type Docker = (args: string[]) => { code: number; stdout: string };

const realDocker: Docker = (args) => exec("docker", args);

// Removes every running container that mounts `dir` or something under it, and returns their ids. A worker that
// died leaves its sandbox running on the slot; the slot cannot be rebuilt under it. If docker cannot be asked
// (not installed, daemon down) nothing is stopped: the next sandbox says what is wrong.
export function removeSandboxesUnder(
  dir: string,
  docker: Docker = realDocker,
): string[] {
  const listed = docker(["ps", "-q"]);
  const running =
    listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
  if (running.length === 0) return [];
  // one line per container: its id, then the host path of each mount, tab separated. A container that exited
  // between the two calls makes inspect fail but the others are still printed, so the output is read regardless.
  const inspected = docker([
    "inspect",
    "--format",
    "{{.Id}}\t{{range .Mounts}}{{.Source}}\t{{end}}",
    ...running,
  ]);
  const here = inspected.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").filter(Boolean))
    .filter(([, ...sources]) =>
      sources.some((source) => source === dir || source.startsWith(dir + sep)),
    )
    .map(([id]) => id as string);
  if (here.length === 0) return [];
  return docker(["rm", "-f", ...here]).code === 0 ? here : [];
}

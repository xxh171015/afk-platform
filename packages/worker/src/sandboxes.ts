import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { type ExecResult, exec, SANDBOX_KIND_LABEL } from "@afk/pipeline";

export type Docker = (
  args: string[],
) => Pick<ExecResult, "code" | "stdout" | "timedOut">;

// Looking is quick; removing a running container may take a few seconds for it to stop.
const LOOK_TIMEOUT_MS = 10_000;
const REMOVE_TIMEOUT_MS = 30_000;

const realDocker: Docker = (args) =>
  exec("docker", args, {
    timeoutMs: args[0] === "rm" ? REMOVE_TIMEOUT_MS : LOOK_TIMEOUT_MS,
  });

// The places `dir` may be called by: docker reports the real path of a mount, a symlinked AFK_HOME is not that.
// A directory that is already gone is resolved through its nearest parent that exists.
function namesOf(dir: string): string[] {
  const names = [dir];
  for (let at = dir, rest = ""; ; ) {
    try {
      names.push(join(realpathSync(at), rest));
      break;
    } catch {
      const parent = dirname(at);
      if (parent === at) break;
      rest = join(basename(at), rest);
      at = parent;
    }
  }
  return [...new Set(names)];
}

// Removes every container (running or not) that mounts `dir` or something under it, and returns their ids. A worker that
// died leaves its sandbox running on the slot; the slot cannot be rebuilt under it. If docker cannot be asked
// (not installed, daemon down, not answering) nothing is removed and `log` says so: the next sandbox will fail
// with docker's own words.
export function removeSandboxesUnder(
  dir: string,
  docker: Docker = realDocker,
  log: (line: string) => void = () => {},
): string[] {
  const giveUp = (what: string, answer: ReturnType<Docker>): string[] => {
    log(
      answer.timedOut
        ? `docker did not answer in time (${what}): the sandboxes on ${dir}, if any, may still be there`
        : `docker could not be asked (${what}, exit ${answer.code}): the sandboxes on ${dir}, if any, may still be there`,
    );
    return [];
  };
  const names = namesOf(dir);
  const matching = (ids: string[]): string[] | "failed" => {
    if (ids.length === 0) return [];
    // one line per container: its id, then the host path of each mount, tab separated. A container that exited
    // between the two calls makes inspect fail but the others are still printed, so the output is read regardless
    // (unless inspect timed out).
    const inspected = docker([
      "inspect",
      "--format",
      "{{.Id}}\t{{range .Mounts}}{{.Source}}\t{{end}}",
      ...ids,
    ]);
    if (inspected.timedOut) {
      giveUp("inspect", inspected);
      return "failed";
    }
    return inspected.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").filter(Boolean))
      .filter(([, ...sources]) =>
        sources.some((source) =>
          names.some(
            (name) => source === name || source.startsWith(name + sep),
          ),
        ),
      )
      .map(([id]) => id as string);
  };

  // Labels first: leftover AFK sandboxes carry afk.kind. Mount path is the fallback for containers that
  // never got a label (a worker from before hardening, or a create that died mid-run).
  const labelled = docker([
    "ps",
    "-a",
    "-q",
    "--filter",
    `label=${SANDBOX_KIND_LABEL}`,
  ]);
  if (labelled.code !== 0) return giveUp("ps", labelled);
  const byLabel = matching(labelled.stdout.split("\n").filter(Boolean));
  if (byLabel === "failed") return [];

  // -a: a sandbox whose network was gone is left `Created`, and still holds its mounts
  const listed = docker(["ps", "-a", "-q"]);
  if (listed.code !== 0) return giveUp("ps", listed);
  const byMount = matching(listed.stdout.split("\n").filter(Boolean));
  if (byMount === "failed") return [];

  const seen = new Set<string>();
  const here: string[] = [];
  for (const id of [...byLabel, ...byMount]) {
    if (seen.has(id)) continue;
    seen.add(id);
    here.push(id);
  }
  if (here.length === 0) return [];
  const removed = docker(["rm", "-f", ...here]);
  return removed.code === 0 ? here : giveUp("rm", removed);
}

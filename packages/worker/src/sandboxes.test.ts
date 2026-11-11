import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Docker, removeSandboxesUnder } from "./sandboxes.ts";

// A docker whose containers are listed as id -> the host paths they mount; `rm -f` takes them away.
// `created` are containers that never started: `docker ps` only shows them with -a.
function fakeDocker(
  containers: Record<string, string[]>,
  created: readonly string[] = [],
  labels: Record<string, Record<string, string>> = {},
) {
  const calls: string[][] = [];
  const docker: Docker = (args) => {
    calls.push(args);
    if (args[0] === "ps") {
      const filter = args.includes("--filter")
        ? args[args.indexOf("--filter") + 1]
        : undefined;
      const wanted = filter?.startsWith("label=")
        ? filter.slice("label=".length)
        : undefined;
      const [key, value] = wanted?.split("=") ?? [];
      return {
        code: 0,
        stdout: `${Object.keys(containers)
          .filter((id) => args.includes("-a") || !created.includes(id))
          .filter((id) => {
            if (!key) return true;
            const found = labels[id]?.[key];
            return value ? found === value : found !== undefined;
          })
          .join("\n")}\n`,
      };
    }
    if (args[0] === "inspect") {
      const ids = args.filter((a) => a in containers);
      return {
        code: 0,
        stdout: ids
          .map((id) => `${id}\t${(containers[id] as string[]).join("\t")}\t\n`)
          .join(""),
      };
    }
    if (args[0] === "rm") for (const id of args.slice(2)) delete containers[id];
    return { code: 0, stdout: "" };
  };
  return { docker, calls, containers };
}

describe("removeSandboxesUnder", () => {
  it("removes the containers that mount the slot's directory or anything under it, and only those", () => {
    const fake = fakeDocker({
      a1: ["/home/w/slots/0/backend/.git", "/tmp/ctx"],
      b2: ["/home/w/slots/1/backend/.git"],
      c3: ["/home/w/slots/0"],
      d4: ["/home/w/slots/00/backend"],
    });
    expect(removeSandboxesUnder("/home/w/slots/0", fake.docker).sort()).toEqual(
      ["a1", "c3"],
    );
    expect(Object.keys(fake.containers).sort()).toEqual(["b2", "d4"]);
  });

  it("removes a container that was left Created, which a plain ps does not list", () => {
    const fake = fakeDocker({ a1: ["/home/w/slots/0/backend/.git"] }, ["a1"]);
    expect(removeSandboxesUnder("/home/w/slots/0", fake.docker)).toEqual([
      "a1",
    ]);
  });

  it("does nothing, and asks nothing more, when no container is running", () => {
    const fake = fakeDocker({});
    expect(removeSandboxesUnder("/home/w/slots/0", fake.docker)).toEqual([]);
    expect(fake.calls).toEqual([
      ["ps", "-a", "-q", "--filter", "label=afk.kind"],
      ["ps", "-a", "-q"],
    ]);
  });

  it("carries on when docker cannot be asked: nothing is removed, nothing throws, and it says so", () => {
    const down: Docker = () => ({ code: 1, stdout: "" });
    const logs: string[] = [];
    expect(
      removeSandboxesUnder("/home/w/slots/0", down, (line) => logs.push(line)),
    ).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/docker could not be asked/);
  });

  it("carries on when docker does not answer in time, and says so", () => {
    const hung: Docker = () => ({ code: -1, stdout: "", timedOut: true });
    const logs: string[] = [];
    expect(
      removeSandboxesUnder("/home/w/slots/0", hung, (line) => logs.push(line)),
    ).toEqual([]);
    expect(logs[0]).toMatch(/did not answer in time/);
  });

  it("resolves the symlink through the nearest parent that exists when the slot directory is already gone", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-sandboxes-")));
    const real = join(base, "real");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(base, "link"));
    const fake = fakeDocker({ a1: [`${real}/0/backend/.git`] });
    expect(removeSandboxesUnder(join(base, "link", "0"), fake.docker)).toEqual([
      "a1",
    ]);
  });

  it("finds a container whose mount docker reports under the real path of a symlinked directory", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "afk-sandboxes-")));
    const real = join(base, "real");
    mkdirSync(join(real, "0"), { recursive: true });
    symlinkSync(real, join(base, "link"));
    const fake = fakeDocker({ a1: [`${real}/0/backend/.git`] });
    expect(removeSandboxesUnder(join(base, "link", "0"), fake.docker)).toEqual([
      "a1",
    ]);
  });

  it("matches a docker mount reported under the real path of the temp directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-sandboxes-"));
    const fake = fakeDocker({
      a1: [`${realpathSync(dir)}/backend/.git`],
    });
    expect(removeSandboxesUnder(dir, fake.docker)).toEqual(["a1"]);
  });

  it("finds leftover sandboxes by the afk.kind label, and still removes an unlabelled one by its mount", () => {
    const labelled = fakeDocker({ a1: ["/home/w/slots/0/backend/.git"] }, [], {
      a1: { "afk.kind": "gate" },
    });
    expect(removeSandboxesUnder("/home/w/slots/0", labelled.docker)).toEqual([
      "a1",
    ]);
    expect(
      labelled.calls.some(
        (call) =>
          call[0] === "ps" &&
          call.includes("--filter") &&
          call.some((arg) => arg.includes("afk.kind")),
      ),
    ).toBe(true);

    const unlabelled = fakeDocker({
      b2: ["/home/w/slots/0/backend/.git"],
    });
    expect(removeSandboxesUnder("/home/w/slots/0", unlabelled.docker)).toEqual([
      "b2",
    ]);
  });
});

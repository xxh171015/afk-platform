import { describe, expect, it } from "vitest";
import { type Docker, removeSandboxesUnder } from "./sandboxes.ts";

// A docker whose containers are listed as id -> the host paths they mount; `rm -f` takes them away.
function fakeDocker(containers: Record<string, string[]>) {
  const calls: string[][] = [];
  const docker: Docker = (args) => {
    calls.push(args);
    if (args[0] === "ps")
      return { code: 0, stdout: `${Object.keys(containers).join("\n")}\n` };
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

  it("does nothing, and asks nothing more, when no container is running", () => {
    const fake = fakeDocker({});
    expect(removeSandboxesUnder("/home/w/slots/0", fake.docker)).toEqual([]);
    expect(fake.calls).toEqual([["ps", "-q"]]);
  });

  it("carries on when docker cannot be asked: nothing is stopped and nothing throws", () => {
    const down: Docker = () => ({ code: 1, stdout: "" });
    expect(removeSandboxesUnder("/home/w/slots/0", down)).toEqual([]);
  });
});

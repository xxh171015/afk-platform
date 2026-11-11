import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planAgentDocs } from "./agent-docs.ts";
import { excludeLocally, isTracked } from "./git-exclude.ts";
import { TRACKER_DOC_PATH } from "./init.ts";
import { renderTrackerDoc, type TrackerDocProject } from "./tracker-doc.ts";

// The files plat writes into the planning repo for the planning skills: the tracker doc and the agent docs
// (agent-docs.ts). `plat init` writes them when it sets a repo up, `plat sync` whenever the platform's change. What the
// repo does not track stays on this machine (ADR 0007).

export type FileState = "new" | "updated" | "unchanged";

export interface PlanningFilesWritten {
  trackerDoc: FileState;
  docs: Record<string, FileState>; // the agent docs, by path
  localPaths: string[]; // in .git/info/exclude
  tracked: string[]; // changed files the repo tracks: the person commits them
}

const stateOf = (before: string | null, after: string): FileState =>
  before === null ? "new" : before === after ? "unchanged" : "updated";

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export function writePlanningFiles(
  dir: string,
  afkHome: string,
  project: TrackerDocProject,
  repoName: string,
): PlanningFilesWritten {
  const agentDocs = planAgentDocs(dir, afkHome);
  const trackerDocTracked = isTracked(dir, TRACKER_DOC_PATH);
  const localPaths = [
    ...(trackerDocTracked ? [] : [TRACKER_DOC_PATH]),
    ...agentDocs.filter((d) => !d.tracked).map((d) => d.path),
  ];
  const tracked: string[] = [];
  const write = (path: string, text: string, isTracked: boolean) => {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    if (isTracked) tracked.push(path);
  };

  const doc = renderTrackerDoc(project, repoName);
  const trackerDoc = stateOf(read(join(dir, TRACKER_DOC_PATH)), doc);
  if (trackerDoc !== "unchanged")
    write(TRACKER_DOC_PATH, doc, trackerDocTracked);
  const docs: Record<string, FileState> = {};
  for (const agentDoc of agentDocs) {
    docs[agentDoc.path] = stateOf(agentDoc.before, agentDoc.after);
    if (docs[agentDoc.path] !== "unchanged")
      write(agentDoc.path, agentDoc.after, agentDoc.tracked);
  }
  excludeLocally(dir, localPaths);
  return { trackerDoc, docs, localPaths, tracked };
}

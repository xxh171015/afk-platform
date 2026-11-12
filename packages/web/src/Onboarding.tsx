import { skillsPackageAt } from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import type { ReactNode } from "react";
import { apiBase, describeError, useApi } from "./api.tsx";
import { ConnectedProjects } from "./ConnectedProjects.tsx";
import { CopyCommand } from "./components/afk/code.tsx";
import { Hint } from "./components/afk/hint.tsx";
import { ErrorState } from "./components/afk/states.tsx";
import { Button } from "./components/ui/button.tsx";
import { formatAbsoluteTime } from "./time.ts";

// Getting a project onto the platform from the control tower (#181 / #186): the skills install
// command pinned to the platform's commit, then /afk-setup. Project settings live elsewhere.

export const installCommand = (commit: string) =>
  `npx skills@latest add ${skillsPackageAt(commit)}`;

const TRACKER_DOC_COMMAND =
  "plat tracker-doc --project <项目 id> --repo <仓库名> > docs/agents/issue-tracker.md";
const AGENTS_MD_COMMAND = "test -f AGENTS.md";

const isLocal = (address: string) => {
  try {
    const host = new URL(address).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
};

export function useProjectList() {
  const api = useApi();
  return useQuery({
    queryKey: ["onboarding", "projects"],
    queryFn: async () => {
      const { data, error } = await api.GET("/projects");
      if (!data) throw new Error(describeError(error));
      const listed = data.projects;
      const missing = listed.filter(
        (project) => project.feishuChatId === undefined,
      );
      if (missing.length === 0) return listed;
      const chats = await Promise.all(
        missing.map(async (project) => {
          const detail = await api.GET("/projects/{projectId}", {
            params: { path: { projectId: project.id } },
          });
          return [project.id, detail.data?.feishuChatId ?? null] as const;
        }),
      );
      const byId = new Map(chats);
      return listed.map((project) =>
        project.feishuChatId !== undefined
          ? project
          : { ...project, feishuChatId: byId.get(project.id) ?? null },
      );
    },
  });
}

function usePlatformVersion() {
  const api = useApi();
  return useQuery({
    queryKey: ["onboarding", "version"],
    queryFn: async () => {
      const { data, error } = await api.GET("/version");
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });
}

function Steps({ address }: { address: string }) {
  const version = usePlatformVersion();
  const commit = version.data?.platformCommit ?? null;
  return (
    <ol className="space-y-3 text-sm">
      <li className="space-y-1.5">
        <p>在项目的规划仓库里运行：</p>
        {commit ? (
          <CopyCommand command={installCommand(commit)} />
        ) : version.isPending ? (
          <p className="text-muted-foreground">正在读取平台的版本…</p>
        ) : (
          <p className="text-muted-foreground">
            平台说不出它对应的提交，没法给出锁定版本的安装命令；请让运行平台的人检查平台的
            checkout。
          </p>
        )}
      </li>
      <li className="space-y-1.5">
        <p>
          然后在 Cursor 里打开这个规划仓库，输入 <code>/afk-setup</code>
          ；它问平台地址时填 <code className="font-mono">{address}</code>
        </p>
      </li>
      {isLocal(address) ? (
        <li className="text-muted-foreground">
          这个地址是本机地址：只能在平台所在的机器上用。
        </li>
      ) : null}
    </ol>
  );
}

function CheckRow({
  title,
  status,
  command,
  action,
  note,
}: {
  title: string;
  status: string;
  command?: string | null;
  action?: ReactNode;
  note?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span>{title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {status}
        </span>
        {action}
      </div>
      {note ? <p className="text-muted-foreground">{note}</p> : null}
      {command ? <CopyCommand command={command} /> : null}
    </div>
  );
}

const doctorStatus = (status: string | undefined): string => {
  if (status === "ok") return "通过";
  if (status === "fail") return "缺";
  if (status === "warn") return "提示";
  return "尚未检查";
};

function useDoctorReport(projectId: number | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["onboarding", "doctor-report", projectId],
    enabled: projectId !== undefined,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        "/projects/{projectId}/doctor-report",
        { params: { path: { projectId: projectId as number } } },
      );
      if (response.status === 404) return null;
      if (!data) throw new Error(describeError(error));
      return data.report;
    },
  });
}

function LocalChecklist({
  address,
  commit,
  projectId,
}: {
  address: string;
  commit: string | null;
  projectId: number | undefined;
}) {
  const report = useDoctorReport(projectId);
  const item = (id: string) =>
    report.data?.items.find((entry) => entry.id === id);
  const skills = item("skills");
  const plat = item("plat");
  const tracker = item("tracker-doc");
  return (
    <section aria-label="本机" className="space-y-2">
      <h3 className="text-sm font-medium">本机</h3>
      {report.data ? (
        <p className="text-xs text-muted-foreground">
          {report.data.machine} 已检查 ·{" "}
          {formatAbsoluteTime(report.data.checkedAt)}
        </p>
      ) : null}
      <div className="space-y-3 text-sm">
        <CheckRow
          title="skills"
          status={doctorStatus(skills?.status)}
          note={skills?.detail}
          command={skills?.command ?? (commit ? installCommand(commit) : null)}
        />
        <CheckRow
          title="plat"
          status={doctorStatus(plat?.status)}
          note={plat?.detail}
          command={plat?.command ?? `plat connect ${address}`}
        />
        <CheckRow
          title="Tracker doc"
          status={doctorStatus(tracker?.status)}
          note={tracker?.detail}
          command={tracker?.command ?? TRACKER_DOC_COMMAND}
        />
      </div>
    </section>
  );
}

function PlatformChecklist() {
  const version = usePlatformVersion();
  const reachable = version.isSuccess
    ? "通过"
    : version.isError
      ? "失败"
      : "读取中";
  return (
    <section aria-label="接入条件" className="space-y-2">
      <h3 className="text-sm font-medium">接入条件</h3>
      <div className="space-y-3 text-sm">
        <CheckRow
          title="平台可达"
          status={reachable}
          action={
            version.isError ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void version.refetch()}
              >
                重试
              </Button>
            ) : null
          }
        />
        <CheckRow title="已登记的项目和仓库" status="还没有项目" />
        <CheckRow
          title="AGENTS.md"
          status="尚未检查"
          command={AGENTS_MD_COMMAND}
        />
      </div>
    </section>
  );
}

function OnboardingFlow({
  address,
  projectId,
}: {
  address: string;
  projectId: number | undefined;
}) {
  const version = usePlatformVersion();
  return (
    <div className="space-y-4">
      <Steps address={address} />
      <LocalChecklist
        address={address}
        commit={version.data?.platformCommit ?? null}
        projectId={projectId}
      />
      {projectId === undefined ? <PlatformChecklist /> : null}
    </div>
  );
}

export function Onboarding({
  address = apiBase(),
  feishu,
}: {
  address?: string;
  feishu?: {
    open: boolean;
    closedReason: "missing" | "permissions" | "invalid" | null;
  };
}) {
  const projects = useProjectList();
  if (projects.isPending) return null;
  if (projects.isError) {
    return (
      <section aria-label="接入" className="mb-8">
        <ErrorState
          error={projects.error}
          prefix="无法读取项目"
          onRetry={() => void projects.refetch()}
        />
      </section>
    );
  }
  if (projects.data.length === 0) {
    return (
      <section
        aria-label="接入第一个项目"
        className="mb-8 space-y-4 rounded-lg border border-border-strong p-5"
      >
        <h2 className="flex items-center gap-2 text-base font-medium">
          <Plug className="size-4 text-primary" />
          接入第一个项目
        </h2>
        <OnboardingFlow address={address} projectId={undefined} />
      </section>
    );
  }
  return (
    <>
      <ConnectedProjects projects={projects.data} feishu={feishu} />
      <details aria-label="接入新项目" className="afk-disclosure mb-6 text-sm">
        <summary>接入新项目</summary>
        <div className="mt-3 space-y-3 rounded-lg border border-border p-4">
          <Hint>
            第一次把仓库接到平台时用。已经在跑的项目，去上面「已接入的项目」改飞书。
          </Hint>
          <OnboardingFlow address={address} projectId={projects.data[0]?.id} />
        </div>
      </details>
    </>
  );
}

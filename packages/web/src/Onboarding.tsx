import { skillsPackageAt } from "@afk/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { type ReactNode, useState } from "react";
import { apiBase, describeError, useApi } from "./api.tsx";
import { CopyCommand } from "./components/afk/code.tsx";
import { ErrorState } from "./components/afk/states.tsx";
import { Button } from "./components/ui/button.tsx";
import { DETAIL_POLL_MS } from "./live.ts";
import { paths } from "./paths.ts";
import { formatAbsoluteTime } from "./time.ts";

// Getting a project onto the platform from the control tower (#181 / #186): the skills install
// command pinned to the platform's commit, then /afk-setup, plus a two-part checklist of 本机
// and 接入条件. In plain sight while there is no project; folded away once there is one.

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

function useProjectList() {
  const api = useApi();
  return useQuery({
    queryKey: ["onboarding", "projects"],
    queryFn: async () => {
      const { data, error } = await api.GET("/projects");
      if (!data) throw new Error(describeError(error));
      return data.projects;
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

function accessChecking(access: {
  state?: string;
  checking?: boolean;
}): boolean {
  return access.checking === true || access.state === "pending";
}

function accessStatus(
  access:
    | {
        state: string;
        checking?: boolean;
        files?: { gates?: boolean; integrationCompose?: boolean };
        hints?: string[];
      }
    | undefined,
  pending: boolean,
  error: boolean,
): string {
  if (pending) return "读取中";
  if (error) return "失败";
  if (!access) return "尚未检查";
  if (accessChecking(access)) return "检查中";
  if (access.state === "unchecked") return "尚未检查";
  if (access.state === "ok")
    return access.hints && access.hints.length > 0 ? "提示" : "通过";
  if (access.state === "not-installed") return "未安装 App";
  if (access.state === "missing-permissions") return "权限不足";
  if (access.state === "not-member") return "不是项目成员";
  if (access.state === "error") return "失败";
  return access.state;
}

function RepoAccessRow({
  projectId,
  repo,
}: {
  projectId: number;
  repo: { name: string; hostKind: string };
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const gitlab = repo.hostKind === "gitlab";
  const access = useQuery({
    queryKey: ["onboarding", "access", projectId, repo.name],
    queryFn: async () => {
      const { data, error } = await api.GET(
        "/projects/{projectId}/repos/{name}/access",
        { params: { path: { projectId, name: repo.name } } },
      );
      if (!data) throw new Error(describeError(error));
      return data;
    },
    refetchInterval: (query) =>
      query.state.data && accessChecking(query.state.data)
        ? DETAIL_POLL_MS
        : false,
  });
  const check = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        "/projects/{projectId}/repos/{name}/access-check",
        { params: { path: { projectId, name: repo.name } } },
      );
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(
        ["onboarding", "access", projectId, repo.name],
        data,
      );
    },
  });
  const files =
    access.data && "files" in access.data ? access.data.files : undefined;
  const hints =
    access.data && "hints" in access.data ? access.data.hints : undefined;
  const fix = access.data && "fix" in access.data ? access.data.fix : undefined;
  const checking = access.data ? accessChecking(access.data) : false;
  const checkedAt =
    access.data && "checkedAt" in access.data
      ? access.data.checkedAt
      : undefined;
  return (
    <li className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {repo.name}
          {gitlab ? "（GitLab）" : ""}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {accessStatus(access.data, access.isPending, access.isError)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={check.isPending || checking}
          onClick={() => check.mutate()}
        >
          现在检查
        </Button>
        {checkedAt ? (
          <span className="text-[11px] text-muted-foreground">
            上次检查 {formatAbsoluteTime(checkedAt)}
          </span>
        ) : null}
      </div>
      {fix ? <p className="text-muted-foreground">{fix}</p> : null}
      {hints?.includes("personal-token") ? (
        <p className="text-muted-foreground">
          平台用的是个人令牌：推送和 MR 显示为
          {access.data && "username" in access.data && access.data.username
            ? `〈${access.data.username}〉`
            : "令牌用户"}
          ，平台不调合并接口，但合并者是不是平台检测不出；换 bot 账号放 M4
        </p>
      ) : null}
      {hints?.includes("developers-can-merge") ? (
        <p className="text-muted-foreground">Developers 能合并默认分支</p>
      ) : null}
      {files ? (
        <p className="text-muted-foreground">
          门禁文件{files.gates ? "已有" : "没有"}
          {files.integrationCompose
            ? "；联调 compose 已有"
            : "；联调 compose 没有"}
        </p>
      ) : null}
    </li>
  );
}

function ProjectRepos({
  project,
  enabled,
}: {
  project: { id: number; name: string };
  enabled: boolean;
}) {
  const api = useApi();
  const view = useQuery({
    queryKey: ["onboarding", "project", project.id],
    enabled,
    queryFn: async () => {
      const { data, error } = await api.GET("/projects/{projectId}", {
        params: { path: { projectId: project.id } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });
  if (!enabled) return null;
  if (view.isPending) {
    return (
      <p className="text-muted-foreground">正在读取 {project.name} 的仓库…</p>
    );
  }
  if (view.isError) {
    return (
      <p className="text-muted-foreground">
        读不到 {project.name} 的仓库：{view.error.message}
      </p>
    );
  }
  if (view.data.repos.length === 0) {
    return (
      <p className="text-muted-foreground">{project.name} 还没有登记仓库。</p>
    );
  }
  return (
    <ul className="space-y-3">
      {view.data.repos.map((repo) => (
        <RepoAccessRow
          key={`${project.id}-${repo.name}`}
          projectId={project.id}
          repo={repo}
        />
      ))}
    </ul>
  );
}

function AgentsMdRow({
  projectId,
  fallbackCommand,
}: {
  projectId: number | undefined;
  fallbackCommand: string;
}) {
  const report = useDoctorReport(projectId);
  const item = report.data?.items.find((entry) => entry.id === "agents-md");
  return (
    <CheckRow
      title="AGENTS.md"
      status={doctorStatus(item?.status)}
      note={item?.detail}
      command={item?.command ?? fallbackCommand}
    />
  );
}

function AccessChecklist({
  projects,
  readAccess,
}: {
  projects: { id: number; name: string }[];
  readAccess: boolean;
}) {
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
        <CheckRow
          title="已登记的项目和仓库"
          status={
            projects.length === 0 ? "还没有项目" : `${projects.length} 个项目`
          }
        />
        {projects.map((project) => (
          <div key={project.id} className="space-y-2">
            <p>
              {project.name} <a href={paths.project(project.id)}>飞书</a>
            </p>
            <ProjectRepos project={project} enabled={readAccess} />
          </div>
        ))}
        <AgentsMdRow
          projectId={projects[0]?.id}
          fallbackCommand={AGENTS_MD_COMMAND}
        />
      </div>
    </section>
  );
}

function Checklist({
  address,
  projects,
  readAccess,
}: {
  address: string;
  projects: { id: number; name: string }[];
  readAccess: boolean;
}) {
  const version = usePlatformVersion();
  return (
    <div className="space-y-4">
      <LocalChecklist
        address={address}
        commit={version.data?.platformCommit ?? null}
        projectId={projects[0]?.id}
      />
      <AccessChecklist projects={projects} readAccess={readAccess} />
    </div>
  );
}

export function Onboarding({ address = apiBase() }: { address?: string }) {
  const projects = useProjectList();
  const [open, setOpen] = useState(false);
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
  if (projects.data.length === 0)
    return (
      <section
        aria-label="接入第一个项目"
        className="mb-8 space-y-4 rounded-lg border p-5"
      >
        <h2 className="flex items-center gap-2 text-base font-medium">
          <Plug className="size-4 text-primary" />
          接入第一个项目
        </h2>
        <Steps address={address} />
        <Checklist address={address} projects={[]} readAccess={false} />
      </section>
    );
  return (
    <details
      aria-label="接入新项目"
      className="mb-6 text-sm"
      onToggle={(event) =>
        setOpen((event.currentTarget as HTMLDetailsElement).open)
      }
    >
      <summary className="cursor-pointer text-muted-foreground">
        接入新项目
      </summary>
      <div className="mt-3 space-y-4">
        <Steps address={address} />
        <Checklist
          address={address}
          projects={projects.data}
          readAccess={open}
        />
      </div>
    </details>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describeError, useApi } from "./api.tsx";
import { CopyCommand } from "./components/afk/code.tsx";
import { Button } from "./components/ui/button.tsx";
import { DETAIL_POLL_MS } from "./live.ts";
import { formatAbsoluteTime } from "./time.ts";

const AGENTS_MD_COMMAND = "test -f AGENTS.md";

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

export function RepoAccessRow({
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

export function ProjectRepoAccess({ projectId }: { projectId: number }) {
  const api = useApi();
  const view = useQuery({
    queryKey: ["onboarding", "project", projectId],
    queryFn: async () => {
      const { data, error } = await api.GET("/projects/{projectId}", {
        params: { path: { projectId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });
  const report = useDoctorReport(projectId);
  const agents = report.data?.items.find((entry) => entry.id === "agents-md");

  if (view.isPending) {
    return <p className="text-muted-foreground">正在读取仓库列表…</p>;
  }
  if (view.isError) {
    return (
      <p className="text-muted-foreground">读不到仓库：{view.error.message}</p>
    );
  }
  return (
    <section aria-label="仓库托管" className="space-y-3">
      <h3 className="text-sm font-medium">仓库托管</h3>
      <p className="text-sm text-muted-foreground">
        GitHub 仓库可按「现在检查」复查 App 权限和门禁文件。GitLab
        仅显示上次结果。
      </p>
      {view.data.repos.length === 0 ? (
        <p className="text-muted-foreground">还没有登记仓库。</p>
      ) : (
        <ul className="space-y-3">
          {view.data.repos.map((repo) => (
            <RepoAccessRow
              key={`${projectId}-${repo.name}`}
              projectId={projectId}
              repo={repo}
            />
          ))}
        </ul>
      )}
      <CheckRow
        title="AGENTS.md"
        status={doctorStatus(agents?.status)}
        note={agents?.detail}
        command={agents?.command ?? AGENTS_MD_COMMAND}
      />
    </section>
  );
}

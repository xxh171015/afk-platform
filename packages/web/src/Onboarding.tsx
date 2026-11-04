import { skillsPackageAt } from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { apiBase, describeError, useApi } from "./api.tsx";
import { CopyCommand } from "./components/afk/code.tsx";

// Getting a project onto the platform from the control tower (#181): the skills install command pinned to the
// platform's commit, then /afk-setup in Cursor with the address this page talks to. In plain sight while there is
// no project; folded away once there is one.

export const installCommand = (commit: string) =>
  `npx skills@latest add ${skillsPackageAt(commit)}`;

const isLocal = (address: string) => {
  try {
    const host = new URL(address).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
};

// How many projects there are; undefined until known, or when the look failed.
function useProjectCount() {
  const api = useApi();
  return useQuery({
    queryKey: ["onboarding", "projects"],
    queryFn: async () => {
      const { data, error } = await api.GET("/projects");
      if (!data) throw new Error(describeError(error));
      return data.projects.length;
    },
  });
}

// The platform's commit the install command pins; null when the platform does not say.
function usePlatformCommit() {
  const api = useApi();
  return useQuery({
    queryKey: ["onboarding", "version"],
    queryFn: async () => {
      const { data, error } = await api.GET("/version");
      if (!data) throw new Error(describeError(error));
      return data.platformCommit;
    },
  });
}

function Steps({ address }: { address: string }) {
  const commit = usePlatformCommit();
  return (
    <ol className="space-y-3 text-sm">
      <li className="space-y-1.5">
        <p>在项目的规划仓库里运行：</p>
        {commit.data ? (
          <CopyCommand command={installCommand(commit.data)} />
        ) : commit.isPending ? (
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

export function Onboarding({ address = apiBase() }: { address?: string }) {
  const projects = useProjectCount();
  if (projects.isPending) return null;
  if (projects.data === 0)
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
      </section>
    );
  // there are projects, or it could not be told: a small entry
  return (
    <details aria-label="接入新项目" className="mb-6 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        接入新项目
      </summary>
      <div className="mt-3">
        <Steps address={address} />
      </div>
    </details>
  );
}

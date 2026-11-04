import { SKILLS_PACKAGE, skillsPackageAt } from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { apiBase, describeError, useApi } from "./api.tsx";
import { CopyCommand } from "./components/afk/code.tsx";

// Getting a project onto the platform from the control tower (#173): the skills install command pinned to the
// platform's commit, then /afk-setup in Cursor with the address this page talks to. In plain sight while there is
// no project; folded away once there is one.

export const installCommand = (commit: string | null) =>
  `npx skills@latest add ${commit ? skillsPackageAt(commit) : SKILLS_PACKAGE}`;

const isLocal = (address: string) => {
  try {
    const host = new URL(address).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
};

function useOnboarding() {
  const api = useApi();
  return useQuery({
    queryKey: ["onboarding"],
    queryFn: async () => {
      const [projects, version] = await Promise.all([
        api.GET("/projects"),
        api.GET("/version"),
      ]);
      if (!projects.data) throw new Error(describeError(projects.error));
      if (!version.data) throw new Error(describeError(version.error));
      return {
        projects: projects.data.projects.length,
        commit: version.data.platformCommit,
      };
    },
  });
}

function Steps({
  commit,
  address,
}: {
  commit: string | null;
  address: string;
}) {
  return (
    <ol className="space-y-3 text-sm">
      <li className="space-y-1.5">
        <p>在项目的规划仓库里运行：</p>
        <CopyCommand command={installCommand(commit)} />
      </li>
      <li className="space-y-1.5">
        <p>
          然后在 Cursor 里打开项目的仓库，输入 <code>/afk-setup</code>
          ；它问平台地址时填：
        </p>
        <CopyCommand command={address} />
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
  const { data } = useOnboarding();
  // nothing to say until both answers are in; a failed look leaves the page as it was
  if (!data) return null;
  if (data.projects === 0)
    return (
      <section
        aria-label="接入第一个项目"
        className="mb-8 space-y-4 rounded-lg border p-5"
      >
        <h2 className="flex items-center gap-2 text-base font-medium">
          <Plug className="size-4 text-primary" />
          接入第一个项目
        </h2>
        <Steps commit={data.commit} address={address} />
      </section>
    );
  return (
    <details aria-label="接入新项目" className="mb-6 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        接入新项目
      </summary>
      <div className="mt-3">
        <Steps commit={data.commit} address={address} />
      </div>
    </details>
  );
}

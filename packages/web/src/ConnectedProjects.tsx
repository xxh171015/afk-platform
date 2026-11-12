import { Settings2 } from "lucide-react";
import { Hint } from "./components/afk/hint.tsx";
import { Button } from "./components/ui/button.tsx";
import { feishuClosedMessage } from "./feishu-status.ts";
import { paths } from "./paths.ts";

export type ProjectListItem = {
  id: number;
  name: string;
  feishuChatId?: string | null;
};

function feishuLabel(
  channel:
    | {
        open: boolean;
        closedReason: "missing" | "permissions" | "invalid" | null;
      }
    | undefined,
  chatId: string | null | undefined,
): string {
  if (channel && !channel.open) {
    return feishuClosedMessage(channel) ?? "飞书渠道已关闭";
  }
  if (chatId && chatId.length > 0) return "已配飞书群";
  return "未配飞书群";
}

export function ConnectedProjects({
  projects,
  feishu,
}: {
  projects: ProjectListItem[];
  feishu?: {
    open: boolean;
    closedReason: "missing" | "permissions" | "invalid" | null;
  };
}) {
  if (projects.length === 0) return null;
  return (
    <section aria-label="已接入的项目" className="mb-6 space-y-3">
      <h2 className="text-sm font-medium">已接入的项目</h2>
      <Hint>
        日常改飞书群、测发送、查仓库权限，点「设置」。模型和并发仍用 plat
        project edit。
      </Hint>
      <ul className="grid gap-3 sm:grid-cols-2">
        {projects.map((project) => (
          <li
            key={project.id}
            className="flex flex-col gap-2 rounded-lg border border-border-strong bg-card p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">{project.name}</p>
                <p className="text-xs text-muted-foreground">
                  {feishuLabel(feishu, project.feishuChatId)}
                </p>
              </div>
              <Button variant="default" size="sm" asChild>
                <a href={paths.project(project.id)}>
                  <Settings2 className="size-3.5" aria-hidden />
                  设置
                </a>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

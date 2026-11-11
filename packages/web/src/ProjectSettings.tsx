import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { Page } from "./components/afk/page.tsx";
import { ErrorState, Skeleton, StaleNotice } from "./components/afk/states.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { feishuClosedMessage, useWorkbench } from "./Workbench.tsx";

export function ProjectSettings({ projectId }: { projectId: number }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const board = useWorkbench();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const { data, error } = await api.GET("/projects/{projectId}", {
        params: { path: { projectId } },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });
  const [chatId, setChatId] = useState<string | null>(null);
  const stored = project.data?.feishuChatId ?? "";
  const value = chatId ?? stored;
  const feishu = board.data?.status.feishu;
  const closed = feishu ? feishuClosedMessage(feishu) : null;

  const save = useMutation({
    mutationFn: async (feishuChatId: string) => {
      const { data, error } = await api.PATCH("/projects/{projectId}", {
        params: { path: { projectId } },
        body: { feishuChatId },
      });
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
  const testSend = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        "/projects/{projectId}/feishu-test",
        { params: { path: { projectId } } },
      );
      if (!data) throw new Error(describeError(error));
      return data;
    },
  });

  if (project.isError && !project.data) {
    return (
      <Page title="项目">
        <ErrorState
          error={project.error}
          prefix="无法加载项目"
          onRetry={() => void project.refetch()}
        />
      </Page>
    );
  }

  return (
    <Page
      title={project.data ? `飞书：${project.data.name}` : "飞书"}
      subtitle="项目页只改飞书群号。模型和并发仍用 plat project edit。"
      actions={<StaleNotice error={project.data ? project.error : null} />}
    >
      {!project.data ? (
        <Skeleton className="h-8 w-64" />
      ) : (
        <div className="max-w-lg space-y-4">
          {closed ? (
            <p role="status" data-testid="feishu-closed">
              {closed}
            </p>
          ) : null}
          <div className="block space-y-1 text-sm">
            <label htmlFor="feishu-chat-id">飞书群 chat_id</label>
            <Input
              id="feishu-chat-id"
              value={value}
              onChange={(event) => setChatId(event.target.value)}
              aria-label="飞书群 chat_id"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate(value)}
            >
              保存群号
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={testSend.isPending}
              onClick={() => testSend.mutate()}
            >
              测试发送
            </Button>
          </div>
          {save.error ? <p role="alert">{save.error.message}</p> : null}
          {testSend.error ? <p role="alert">{testSend.error.message}</p> : null}
          {testSend.data ? (
            <p role="status">已发送到 {testSend.data.chatId}</p>
          ) : null}
        </div>
      )}
    </Page>
  );
}

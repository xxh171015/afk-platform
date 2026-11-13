import {
  STAGE_MODEL_KEYS,
  type StageModelKey,
  type StageModels,
  type TicketReviewMode,
} from "@afk/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { describeError, useApi } from "./api.tsx";
import { Hint } from "./components/afk/hint.tsx";
import { Page } from "./components/afk/page.tsx";
import { ErrorState, Skeleton, StaleNotice } from "./components/afk/states.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  describeFeishuActionError,
  feishuClosedMessage,
} from "./feishu-status.ts";
import { ProjectRepoAccess } from "./project-access.tsx";
import { useWorkbench } from "./Workbench.tsx";

const SECRETS_FILE = "~/.afk/secrets/feishu/app.json";

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
  const [ticketReviewDraft, setTicketReviewDraft] =
    useState<TicketReviewMode | null>(null);
  const storedReview = project.data?.ticketReview ?? "spec";
  const ticketReview = ticketReviewDraft ?? storedReview;
  const [stageModelDraft, setStageModelDraft] = useState<
    Partial<Record<StageModelKey, string>>
  >({});
  const storedModels = project.data?.stageModels ?? {};
  const stageModelValue = (key: StageModelKey) =>
    Object.hasOwn(stageModelDraft, key)
      ? (stageModelDraft[key] ?? "")
      : (storedModels[key] ?? "");
  const feishu = board.data?.status.feishu;
  const closed = feishu ? feishuClosedMessage(feishu) : null;

  const persistChat = async (feishuChatId: string) => {
    const { data, error } = await api.PATCH("/projects/{projectId}", {
      params: { path: { projectId } },
      body: { feishuChatId },
    });
    if (!data) {
      throw new Error(describeFeishuActionError(describeError(error), closed));
    }
    await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    await queryClient.invalidateQueries({
      queryKey: ["onboarding", "projects"],
    });
    return data;
  };
  const save = useMutation({
    mutationFn: (feishuChatId: string) => persistChat(feishuChatId),
  });
  const saveReview = useMutation({
    mutationFn: async (next: TicketReviewMode) => {
      const { data, error } = await api.PATCH("/projects/{projectId}", {
        params: { path: { projectId } },
        body: { ticketReview: next },
      });
      if (!data) throw new Error(describeError(error));
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      return data;
    },
  });
  const saveStageModels = useMutation({
    mutationFn: async (next: StageModels) => {
      const { data, error } = await api.PATCH("/projects/{projectId}", {
        params: { path: { projectId } },
        body: { stageModels: next },
      });
      if (!data) throw new Error(describeError(error));
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      return data;
    },
  });
  const testSend = useMutation({
    mutationFn: async () => {
      const next = value.trim();
      if (!next) {
        throw new Error(
          "还没填群 ID。打开飞书群设置 → 群信息，复制 oc_ 开头的那一串，填好后再测。",
        );
      }
      if (next !== stored) await persistChat(next);
      const { data, error } = await api.POST(
        "/projects/{projectId}/feishu-test",
        { params: { path: { projectId } } },
      );
      if (!data) {
        throw new Error(
          describeFeishuActionError(describeError(error), closed),
        );
      }
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
      title={project.data ? `项目：${project.data.name}` : "项目"}
      subtitle="此页改飞书群、票级审查、阶段模型，并查仓库托管。默认模型、并发、保护路径用 plat project edit。"
      actions={<StaleNotice error={project.data ? project.error : null} />}
    >
      {!project.data ? (
        <Skeleton className="h-8 w-64" />
      ) : (
        <div className="max-w-xl space-y-8">
          <section aria-label="票级审查" className="space-y-4">
            <h2 className="text-sm font-medium">票级审查</h2>
            <Hint>
              默认只跑 Spec 轴。Standards 轴仍在需求收尾的 final-review 跑。
            </Hint>
            <div className="block space-y-1 text-sm">
              <label htmlFor="ticket-review">票级审查</label>
              <select
                id="ticket-review"
                aria-label="票级审查"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                value={ticketReview}
                onChange={(event) =>
                  setTicketReviewDraft(event.target.value as TicketReviewMode)
                }
              >
                <option value="spec">只跑 Spec 轴</option>
                <option value="both">Standards 和 Spec 两轴</option>
              </select>
            </div>
            <Button
              type="button"
              disabled={saveReview.isPending}
              onClick={() => saveReview.mutate(ticketReview)}
            >
              保存审查设置
            </Button>
            {saveReview.error ? (
              <p role="alert">{saveReview.error.message}</p>
            ) : null}
          </section>
          <section aria-label="阶段模型" className="space-y-4">
            <h2 className="text-sm font-medium">阶段模型</h2>
            <Hint>
              只读或机械的环节可以单独指定模型。空白表示用项目默认模型。implement、gate-fix
              和 Spec 轴不开放。
            </Hint>
            {STAGE_MODEL_KEYS.map((key) => (
              <div key={key} className="block space-y-1 text-sm">
                <label htmlFor={`stage-model-${key}`}>{key}</label>
                <Input
                  id={`stage-model-${key}`}
                  aria-label={key}
                  value={stageModelValue(key)}
                  onChange={(event) =>
                    setStageModelDraft((prev) => ({
                      ...prev,
                      [key]: event.target.value,
                    }))
                  }
                  placeholder="项目默认模型"
                />
              </div>
            ))}
            <Button
              type="button"
              disabled={saveStageModels.isPending}
              onClick={() => {
                const next: StageModels = {};
                for (const key of STAGE_MODEL_KEYS)
                  next[key] = stageModelValue(key);
                saveStageModels.mutate(next);
              }}
            >
              保存阶段模型
            </Button>
            {saveStageModels.error ? (
              <p role="alert">{saveStageModels.error.message}</p>
            ) : null}
          </section>
          <section aria-label="飞书通知" className="space-y-4">
            <h2 className="text-sm font-medium">飞书通知</h2>
            <Hint>
              票卡住、可验收时会发到这个群，本机横幅同时还会响。密钥不要填在网页里。
            </Hint>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>
                在飞书开放平台建企业自建应用，开通「以应用身份发消息」和「获取群组信息」。
              </li>
              <li>
                把{" "}
                <code className="font-mono text-xs">
                  {`{"app_id":"…","app_secret":"…"}`}
                </code>{" "}
                写到 <code className="font-mono text-xs">{SECRETS_FILE}</code>
                ，然后{" "}
                <code className="font-mono text-xs">
                  chmod 600 {SECRETS_FILE}
                </code>
                。改密钥之后要重启 API。
              </li>
              <li>把这个应用的机器人拉进要收通知的群。</li>
              <li>
                打开该群 → 设置 → 群信息，复制 chat_id（oc_
                开头）。群里看不到时，到开放平台调用「获取机器人所在群列表」。
              </li>
              <li>
                粘贴到下面，点「保存群号」，再点「测试发送」。群里收到一张测试卡片就对了。
              </li>
            </ol>
            {closed ? (
              <p role="status" data-testid="feishu-closed">
                {closed}。密钥文件：{SECRETS_FILE}，权限必须仅自己可读。
              </p>
            ) : null}
            <div className="block space-y-1 text-sm">
              <label htmlFor="feishu-chat-id">飞书群 ID</label>
              <Input
                id="feishu-chat-id"
                value={value}
                onChange={(event) => setChatId(event.target.value)}
                aria-label="飞书群 ID"
                placeholder="oc_ 开头的群 ID"
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
                variant="secondary"
                disabled={testSend.isPending}
                onClick={() => testSend.mutate()}
              >
                测试发送
              </Button>
            </div>
            {save.error ? <p role="alert">{save.error.message}</p> : null}
            {testSend.error ? (
              <p role="alert">{testSend.error.message}</p>
            ) : null}
            {testSend.data ? (
              <p role="status">已发送到 {testSend.data.chatId}</p>
            ) : null}
          </section>
          <ProjectRepoAccess projectId={projectId} />
        </div>
      )}
    </Page>
  );
}

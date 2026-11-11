import { useMutation, useQueryClient } from "@tanstack/react-query";
import { describeError, useApi } from "./api.tsx";
import { Button } from "./components/ui/button.tsx";
import { useWorkbench, WORKBENCH_KEY } from "./Workbench.tsx";

// The agents' provider refused work (usage ran out, the key was refused): no agent job is handed out until a person
// says it takes work again. Gates and merges go on meanwhile, and no ticket was blocked for it.
export function AgentsPausedBanner() {
  const board = useWorkbench();
  const api = useApi();
  const queryClient = useQueryClient();
  const resume = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/agents/resume");
      if (!data) throw new Error(describeError(error));
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WORKBENCH_KEY }),
  });
  const paused = board.data?.status?.agentsPaused;
  if (!paused) return null;
  return (
    <div
      role="status"
      data-testid="agents-paused-banner"
      className="flex flex-wrap items-center gap-3 border-b border-state-blocked/40 bg-state-blocked/10 px-4 py-2 text-sm text-state-blocked"
    >
      <span className="min-w-0 flex-1">
        Agent
        已暂停：模型服务拒绝了请求（额度用完或密钥失效），票没有被卡住，额度恢复后点恢复继续。
        <span
          className="block truncate text-xs opacity-80"
          title={paused.reason}
        >
          {paused.reason}
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        disabled={resume.isPending}
        onClick={() => resume.mutate()}
      >
        恢复
      </Button>
      {resume.error ? <span role="alert">{resume.error.message}</span> : null}
    </div>
  );
}

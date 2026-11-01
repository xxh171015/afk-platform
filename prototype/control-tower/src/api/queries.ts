// TanStack Query 封装：列表每 5 秒、详情每 3 秒轮询；失败时保留旧数据（Query 默认行为）。
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./client";
import type { RetryMode } from "./types";

export const LIST_POLL_MS = 5000;
export const DETAIL_POLL_MS = 3000;

export const qk = {
  specs: ["specs"] as const,
  spec: (id: string) => ["specs", id] as const,
  ticket: (id: string) => ["tickets", id] as const,
  run: (id: string) => ["runs", id] as const,
  blocked: ["blocked"] as const,
  search: (q: string) => ["search", q] as const,
  runLogs: (id: string, offset: number) => ["runs", id, "logs", offset] as const,
};

const common = { retry: 1, refetchIntervalInBackground: false } as const;

export const specsQuery = () =>
  queryOptions({ ...common, queryKey: qk.specs, queryFn: api.listSpecs, refetchInterval: LIST_POLL_MS });

export const blockedQuery = () =>
  queryOptions({ ...common, queryKey: qk.blocked, queryFn: api.getBlocked, refetchInterval: LIST_POLL_MS });

export const specQuery = (id: string) =>
  queryOptions({ ...common, queryKey: qk.spec(id), queryFn: () => api.getSpec(id), refetchInterval: DETAIL_POLL_MS });

export const ticketQuery = (id: string) =>
  queryOptions({ ...common, queryKey: qk.ticket(id), queryFn: () => api.getTicket(id), refetchInterval: DETAIL_POLL_MS });

export const runQuery = (id: string) =>
  queryOptions({ ...common, queryKey: qk.run(id), queryFn: () => api.getRun(id), refetchInterval: DETAIL_POLL_MS });

export const recentRunsQuery = (limit = 15) =>
  queryOptions({ ...common, queryKey: ["runs", "recent", limit], queryFn: () => api.recentRuns(limit), refetchInterval: LIST_POLL_MS });

export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: qk.search(q),
    queryFn: () => api.search(q),
    enabled: q.trim().length > 0,
    retry: false,
  });

export const runLogsQuery = (id: string, offset = 0, attempt?: number) =>
  queryOptions({ queryKey: [...qk.runLogs(id, offset), attempt], queryFn: () => api.getRunLogs(id, offset) });

/* ---------------- 操作 ---------------- */

function useAction<V>(fn: (v: V) => Promise<unknown>, success: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(success);
      qc.invalidateQueries({ queryKey: qk.specs });
      qc.invalidateQueries({ queryKey: qk.blocked });
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

export const useConfirmSpec = () => useAction((id: string) => api.confirmSpec(id), "已确认拆票，开始调度");
export const useResumeSpec = () =>
  useAction((v: { id: string; extraSeconds: number }) => api.resumeSpec(v.id, v.extraSeconds), "已恢复运行");
export const useRetryFinal = () => useAction((id: string) => api.retryFinal(id), "已重试收尾步骤");
export const useWaiveFinal = () => useAction((id: string) => api.waiveFinal(id), "已跳过收尾步骤");
export const useRetryTicket = () =>
  useAction((v: { id: string; mode: RetryMode }) => api.retryTicket(v.id, v.mode), "已重新排队");
export const useApproveProtected = () => useAction((id: string) => api.approveProtected(id), "已批准受保护路径改动");
export const useCancelTicket = () =>
  useAction((v: { id: string; cascade: boolean }) => api.cancelTicket(v.id, v.cascade), "已取消");

// API 客户端。函数签名对应真实 HTTP 端点；当前由内存 mock 实现（300ms 延迟）。
// 换真后端时只需改这里：把每个函数换成 fetch(`${BASE}/...`)。
import type {
  BlockedResponse,
  ListSpecsResponse,
  OkResponse,
  RecentRunsResponse,
  RetryMode,
  RunLogsResponse,
  RunDetailResponse,
  SearchResponse,
  SpecDetailResponse,
  TicketDetailResponse,
} from "./types";
import * as mock from "./mock/server";

const LATENCY_MS = 300;

async function call<T>(fn: () => T): Promise<T> {
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  return fn();
}

export const api = {
  /** GET /specs */
  listSpecs: (): Promise<ListSpecsResponse> => call(() => mock.listSpecs()),
  /** GET /specs/{id} */
  getSpec: (id: string): Promise<SpecDetailResponse> => call(() => mock.getSpec(id)),
  /** GET /tickets/{id} */
  getTicket: (id: string): Promise<TicketDetailResponse> => call(() => mock.getTicket(id)),
  /** GET /runs/{id} （mock 补充端点，仿 recentRuns） */
  getRun: (id: string): Promise<RunDetailResponse> => call(() => mock.getRun(id)),
  /** GET /runs/{id}/logs?offset= */
  getRunLogs: (id: string, offset = 0): Promise<RunLogsResponse> => call(() => mock.getRunLogs(id, offset)),
  /** GET /blocked */
  getBlocked: (): Promise<BlockedResponse> => call(() => mock.getBlocked()),
  /** GET /runs/recent?limit= （mock 补充端点） */
  recentRuns: (limit = 15): Promise<RecentRunsResponse> => call(() => mock.recentRuns(limit)),
  /** GET /search?q= */
  search: (q: string): Promise<SearchResponse> => call(() => mock.search(q)),

  /** POST /specs/{id}/confirm */
  confirmSpec: (id: string): Promise<OkResponse> => call(() => mock.confirmSpec(id)),
  /** POST /specs/{id}/resume { extraSeconds } */
  resumeSpec: (id: string, extraSeconds: number): Promise<OkResponse> =>
    call(() => mock.resumeSpec(id, extraSeconds)),
  /** POST /specs/{id}/final/retry */
  retryFinal: (id: string): Promise<OkResponse> => call(() => mock.retryFinal(id)),
  /** POST /specs/{id}/final/waive */
  waiveFinal: (id: string): Promise<OkResponse> => call(() => mock.waiveFinal(id)),
  /** POST /tickets/{id}/retry { mode } */
  retryTicket: (id: string, mode: RetryMode): Promise<OkResponse> => call(() => mock.retryTicket(id, mode)),
  /** POST /tickets/{id}/approve-protected */
  approveProtected: (id: string): Promise<OkResponse> => call(() => mock.approveProtected(id)),
  /** POST /tickets/{id}/cancel { cascade } */
  cancelTicket: (id: string, cascade: boolean): Promise<OkResponse> => call(() => mock.cancelTicket(id, cascade)),
};

export { blockedCount } from "./mock/server";

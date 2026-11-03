// What GET /events sends when a page-visible row changed. The page maps the ids to its query keys; the API
// only fills the ones it knows (docs/specs/experience-platform.md「页面刷新」).

export interface InvalidatePayload {
  specId?: number;
  ticketId?: number;
  runId?: number;
}

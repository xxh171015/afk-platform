// Shareable addresses of the control tower. Hash addresses such as #/specs/3 are not mapped here.

export const PAGE_PATHS = [
  "/",
  "/waiting",
  "/metrics",
  "/specs",
  "/specs/$specId",
  "/specs/$specId/description",
  "/specs/$specId/tickets",
  "/specs/$specId/delivery",
  "/specs/$specId/timeline",
  "/tickets/$ticketId",
  "/runs/$runId",
  "/projects/$projectId",
] as const;

export const paths = {
  home: "/",
  waiting: "/waiting",
  metrics: "/metrics",
  specs: "/specs",
  spec: (id: number | string) => `/specs/${id}`,
  specDescription: (id: number | string) => `/specs/${id}/description`,
  specTickets: (id: number | string) => `/specs/${id}/tickets`,
  specDelivery: (id: number | string) => `/specs/${id}/delivery`,
  specTimeline: (id: number | string) => `/specs/${id}/timeline`,
  ticket: (id: number | string) => `/tickets/${id}`,
  run: (id: number | string) => `/runs/${id}`,
  project: (id: number | string) => `/projects/${id}`,
} as const;

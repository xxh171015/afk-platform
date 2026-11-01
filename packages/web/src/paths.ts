// Shareable addresses of the control tower. Hash addresses such as #/specs/3 are not mapped here.

export const PAGE_PATHS = [
  "/",
  "/waiting",
  "/specs",
  "/specs/$specId",
  "/tickets/$ticketId",
] as const;

export const paths = {
  home: "/",
  waiting: "/waiting",
  specs: "/specs",
  spec: (id: number | string) => `/specs/${id}`,
  ticket: (id: number | string) => `/tickets/${id}`,
} as const;

// Absolute URLs of the control-tower page, for notices and the acceptance pack. The API process has no
// idea which port the Vite app used unless AFK_PAGE_URL says so.

export const DEFAULT_PAGE_URL = "http://127.0.0.1:5173";

export function pageUrl(path: string): string {
  const base = (process.env.AFK_PAGE_URL ?? DEFAULT_PAGE_URL).replace(
    /\/+$/,
    "",
  );
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

export function originHost(url: string): string {
  const ssh = url.match(/^git@([^:]+):/);
  if (ssh?.[1]) return ssh[1];
  try {
    return new URL(url.replace(/^git\+/, "")).hostname;
  } catch {
    return url;
  }
}

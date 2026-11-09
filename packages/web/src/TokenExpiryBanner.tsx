import { useQuery } from "@tanstack/react-query";
import { useApi } from "./api.tsx";

// A GitLab PAT with 30 days left (or already expired) is shown once the worker has read the expiry date.
export function TokenExpiryBanner() {
  const api = useApi();
  const hosts = useQuery({
    queryKey: ["hosts"],
    queryFn: async () => {
      const { data } = await api.GET("/hosts");
      return data?.hosts ?? [];
    },
  });
  const warnings = (hosts.data ?? []).filter(
    (host) =>
      host.kind === "gitlab" &&
      host.daysLeft !== undefined &&
      host.daysLeft <= 30,
  );
  if (warnings.length === 0) return null;
  return (
    <div
      role="status"
      className="border-b border-border bg-muted/40 px-4 py-2 text-sm"
    >
      {warnings.map((host) => (
        <p key={host.host}>
          {host.daysLeft !== undefined && host.daysLeft < 0
            ? `${host.host} 的 GitLab 个人令牌已于 ${host.tokenExpiresAt} 过期`
            : `${host.host} 的 GitLab 个人令牌将在 ${host.tokenExpiresAt} 到期（还剩 ${host.daysLeft} 天）`}
          ：换令牌后放到{" "}
          <code className="font-mono text-[11px]">
            ~/.afk/secrets/gitlab/{host.host}
          </code>
          ，不用重启 worker
        </p>
      ))}
    </div>
  );
}

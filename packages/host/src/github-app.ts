import { createSign } from "node:crypto";
import {
  HostError,
  type TokenPermissions,
  type TokenRequest,
  type TokenSource,
} from "./types.ts";

// A GitHub App's way to a token: sign a short JWT with the App's private key, trade it for an installation token
// (one hour) that is limited to the one repository and the permissions the job asked for, and keep it until five
// minutes before it expires.

export interface AppCredentials {
  appId: string;
  installationId: string;
  privateKey: string; // PEM
}

export interface AppTokenOptions {
  credentials: AppCredentials;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const REFRESH_BEFORE_MS = 5 * 60 * 1000;

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

export function appJwt(credentials: AppCredentials, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    // issued a minute ago: clocks differ; GitHub allows ten minutes at most
    JSON.stringify({
      iat: seconds - 60,
      exp: seconds + 9 * 60,
      iss: credentials.appId,
    }),
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(credentials.privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

const cacheKey = ({ repo, permissions }: TokenRequest) =>
  `${repo.owner}/${repo.name}:${Object.entries(permissions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, level]) => `${name}=${level}`)
    .join(",")}`;

export function createAppTokenSource(options: AppTokenOptions): TokenSource {
  const { credentials } = options;
  const apiUrl = options.apiUrl ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const cache = new Map<string, { token: string; expiresAt: number }>();
  // Two jobs asking for the same token at once share one exchange.
  const pending = new Map<string, Promise<string>>();

  async function exchange(request: TokenRequest, key: string): Promise<string> {
    const response = await doFetch(
      `${apiUrl}/app/installations/${credentials.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${appJwt(credentials, now())}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          repositories: [request.repo.name],
          permissions: request.permissions satisfies TokenPermissions,
        }),
      },
    );
    if (!response.ok) {
      throw new HostError(
        `GitHub refused an installation token for ${request.repo.owner}/${request.repo.name}: HTTP ${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as {
      token?: string;
      expires_at?: string;
    };
    if (!body.token || !body.expires_at)
      throw new HostError("GitHub's token answer had no token", 502);
    cache.set(key, {
      token: body.token,
      expiresAt: Date.parse(body.expires_at),
    });
    return body.token;
  }

  return {
    async tokenFor(request) {
      const key = cacheKey(request);
      const cached = cache.get(key);
      if (cached && now().getTime() < cached.expiresAt - REFRESH_BEFORE_MS)
        return cached.token;
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const fresh = exchange(request, key).finally(() => pending.delete(key));
      pending.set(key, fresh);
      return fresh;
    },
  };
}

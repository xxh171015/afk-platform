// Secrets never appear in a log line or an error message: each one is replaced by ***. An empty secret is skipped.
export const redactSecrets = (text: string, secrets: readonly string[]) =>
  secrets.reduce(
    (acc, secret) => (secret ? acc.split(secret).join("***") : acc),
    text,
  );

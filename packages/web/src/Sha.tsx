import { shortSha } from "./status.ts";

// First seven characters on the face; click copies the full SHA.

export function Sha({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="link font-mono"
      title={value}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
      }}
    >
      {shortSha(value)}
    </button>
  );
}

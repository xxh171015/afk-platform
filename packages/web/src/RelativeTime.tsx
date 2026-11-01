import { formatAbsoluteTime, formatRelativeTime } from "./time.ts";

// Relative on the face, absolute UTC on hover.

export function RelativeTime({ iso, now }: { iso: string; now?: Date }) {
  return (
    <time dateTime={iso} title={formatAbsoluteTime(iso)}>
      {formatRelativeTime(iso, now)}
    </time>
  );
}

import { statfs } from "node:fs/promises";

export async function freeBytesOf(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

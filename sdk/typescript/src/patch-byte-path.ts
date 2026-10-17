import { posix, win32 } from "node:path";

// Git byte keys remain opaque on POSIX. Windows compares native Unicode paths.
export function relativePatchPath(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return posix.relative(from, to);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return Buffer.from(
    win32.relative(
      decoder.decode(Buffer.from(from, "latin1")),
      decoder.decode(Buffer.from(to, "latin1")),
    ),
  ).toString("latin1");
}

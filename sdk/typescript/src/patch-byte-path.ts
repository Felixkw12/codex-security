import { lstatSync, readdirSync } from "node:fs";
import { sep, posix, win32 } from "node:path";

// Recover directory-entry spelling only when the filesystem accepts an alias.
// Keep exact POSIX bytes, distinct names, and symlinks unchanged.
export function canonicalPatchPath(root: string, key: string): string {
  const parts = (
    process.platform === "win32" ? key.replaceAll("/", sep) : key
  ).split(sep);
  let directory = Buffer.from(root);
  for (let index = 0; index < parts.length; index++) {
    const part = Buffer.from(parts[index]!, "latin1");
    const path = Buffer.concat([directory, Buffer.from(sep), part]);
    try {
      const metadata = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!metadata) break;
      const names = readdirSync(directory, { encoding: "buffer" }).map((name) =>
        Buffer.from(name),
      );
      if (!names.some((name) => name.equals(part))) {
        const name = names.find((name) => {
          const candidate = lstatSync(
            Buffer.concat([directory, Buffer.from(sep), name]),
            { bigint: true, throwIfNoEntry: false },
          );
          return (
            candidate?.dev === metadata.dev && candidate.ino === metadata.ino
          );
        });
        if (name) parts[index] = name.toString("latin1");
      }
      if (!metadata.isDirectory()) break;
      directory = Buffer.concat([
        directory,
        Buffer.from(sep),
        Buffer.from(parts[index]!, "latin1"),
      ]);
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        break;
      throw error;
    }
  }
  return parts.join(sep);
}

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

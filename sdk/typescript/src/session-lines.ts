import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline, type Transform } from "node:stream";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { bundledPluginRoot } from "./runtime.js";

/** Plain and cold compressed rollouts have the same newline-delimited format. */
export async function* sessionLines(path: string): AsyncGenerator<string> {
  const decompressor = path.endsWith(".zst")
    ? await sessionDecompressor()
    : null;
  const file = createReadStream(path);
  const stream =
    decompressor !== null ? pipeline(file, decompressor, () => {}) : file;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    yield* lines;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function sessionDecompressor(): Promise<Transform> {
  if (typeof zlib.createZstdDecompress === "function")
    return zlib.createZstdDecompress();
  const fallback = (await import(
    pathToFileURL(
      join(await bundledPluginRoot(), "mcp", "session-decompression.mjs"),
    ).href
  )) as { createZstdDecompress: () => Transform };
  return fallback.createZstdDecompress();
}

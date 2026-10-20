import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

// The Python usage collector uses the plugin's required Node runtime to read
// cold rollouts without requiring a separate Python compression dependency.
try {
  const path = process.argv[2];
  if (!path) throw new Error("A Codex rollout path is required.");
  const decompressor =
    typeof zlib.createZstdDecompress === "function"
      ? zlib.createZstdDecompress()
      : (
          await import("../mcp/session-decompression.mjs")
        ).createZstdDecompress();
  await pipeline(createReadStream(path), decompressor, process.stdout);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

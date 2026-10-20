import { Transform, type TransformCallback } from "node:stream";
import { Decompress } from "fzstd";

/** Streaming fallback for supported Node versions without native Zstandard. */
export function createZstdDecompress(): Transform {
  let decoder: Decompress;
  const stream = new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      try {
        decoder.push(chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        decoder.push(new Uint8Array(), true);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  decoder = new Decompress((chunk) => stream.push(chunk));
  return stream;
}

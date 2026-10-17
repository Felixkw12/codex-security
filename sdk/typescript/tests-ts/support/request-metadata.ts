import type { CodexOptions } from "@openai/codex-sdk";
import { parse } from "smol-toml";

export function requestMetadata(options: CodexOptions | undefined) {
  const override = options?.configOverrides?.find((value) =>
    value.startsWith("responses_api_metadata="),
  );
  return override === undefined
    ? undefined
    : parse(override)["responses_api_metadata"];
}

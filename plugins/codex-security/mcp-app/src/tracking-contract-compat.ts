import { isIP } from "node:net";
import { isRecord } from "./record.js";

/** Preserve the historical meaning of these immutable schema fields. */
export function adaptTrackingSchema(
  filename: string,
  schema: Record<string, unknown>,
): void {
  const findingProperties = ["properties", "findings", "items", "properties"];
  const scanProperties = ["properties", "scan", "properties"];
  const patterns =
    filename === "findings.json"
      ? [
          {
            path: [
              ...findingProperties,
              "codeEvidence",
              "items",
              "properties",
              "id",
            ],
            before: "^[a-z0-9][a-z0-9._/-]*$",
            after: "^[a-z0-9][a-z0-9._/-]*(?:\\n)?$",
          },
          {
            path: [...findingProperties, "writeup", "properties", "reportPath"],
            before: "^findings/([a-z0-9][a-z0-9._-]*)/\\1\\.md$",
            after: "^findings/([a-z0-9][a-z0-9._-]*)/\\1\\.md(?:\\n)?$",
          },
        ]
      : filename === "scan-manifest.json"
        ? [
            {
              path: [
                ...scanProperties,
                "target",
                "properties",
                "snapshotDigest",
              ],
              before: "^codex-security-snapshot/v1:sha256:[a-f0-9]{64}$",
              after: "^codex-security-snapshot/v1:sha256:[a-f0-9]{64}(?:\\n)?$",
            },
            {
              path: [
                ...scanProperties,
                "threatModel",
                "anyOf",
                1,
                "properties",
                "content",
              ],
              before: "^[\\s\\S]*\\S[\\s\\S]*$",
              after: "^[\\s\\S]*[^\\p{White_Space}\\u001c-\\u001f][\\s\\S]*$",
            },
          ]
        : [];
  for (const { path, before, after } of patterns) {
    let field: unknown = schema;
    for (const key of path) {
      field =
        typeof key === "number" && Array.isArray(field)
          ? field[key]
          : isRecord(field)
            ? field[key]
            : undefined;
    }
    if (isRecord(field) && field["pattern"] === before) {
      field["pattern"] = after;
    }
  }
}

/** Adapt historical remote syntax for validation without changing saved data. */
export function trackingRemoteForValidation(remote: string): string {
  let compatible = remote.replace(/^file:\/\//iu, "https://");
  const scoped = /^([a-z][a-z0-9+.-]*:\/\/)\[([^/?#\]]+)\](.*)$/iu.exec(
    compatible,
  );
  if (scoped === null) return compatible;
  const [address, scope, extra] = scoped[2]!.split("%");
  if (
    scope === undefined ||
    scope.length === 0 ||
    extra !== undefined ||
    isIP(address!) !== 6 ||
    /[\\/@?#\s<>^|\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(scope)
  ) {
    return compatible;
  }
  compatible = `${scoped[1]}[${address}]${scoped[3]}`;
  return compatible;
}

/** Python's timestamp parser carries excess offset minutes into the hour. */
export function isTrackingDateTime(
  value: string,
  validRfc3339DateTime: (value: string) => boolean,
): boolean {
  if (validRfc3339DateTime(value)) return true;
  const offset = /([+-])(\d{2}):(\d{2})$/u.exec(value);
  if (offset === null || Number(offset[3]) < 60) return false;
  const minutes = Number(offset[2]) * 60 + Number(offset[3]);
  if (minutes >= 24 * 60) return false;
  const normalized = `${offset[1]}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return validRfc3339DateTime(value.slice(0, -6) + normalized);
}

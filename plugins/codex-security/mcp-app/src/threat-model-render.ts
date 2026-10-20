import { isRecord } from "./record.js";
import { nonblank, text } from "./threat-model-format.js";
import { threatModelSchemas } from "./threat-model-schema.js";
import * as z from "zod/v4";

const sections = [
  ["Assets", "assets"],
  ["Trust Boundaries", "trustBoundaries"],
  ["Attacker Capabilities", "attackerCapabilities"],
  ["Security Objectives", "securityObjectives"],
  ["Assumptions", "assumptions"],
] as const;
const shapes = threatModelSchemas(
  z.array(z.string().min(1)),
  z.string().refine(nonblank),
);

const fields = [
  ["source", "Source"],
  ["scanId", "Scan"],
  ["target", "Target"],
  ["revision", "Revision"],
  ["snapshotDigest", "Snapshot"],
  ["status", "Result status"],
] as const;
export interface ThreatModelRenderInput {
  threatModel: unknown;
  provenance?: Record<string, unknown>;
}

function truthy(value: unknown): boolean {
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  return Array.isArray(value)
    ? value.length > 0
    : isRecord(value)
      ? Object.keys(value).length > 0
      : Boolean(value);
}

// The old MCP boundary serialized JSON before rendering. This conversion is
// confined to the provenance footer, not canonical JSON output.
function display(value: unknown, nested = false): string {
  if (typeof value === "string") {
    if (!nested) return value;
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return (
      quote +
      [...value]
        .map((character) => {
          if (character === "\\" || character === quote)
            return "\\" + character;
          if (character === "\t") return "\\t";
          if (character === "\n") return "\\n";
          if (character === "\r") return "\\r";
          if (character !== " " && /[\p{C}\p{Z}]/u.test(character)) {
            const point = character.codePointAt(0)!;
            return point <= 0xff
              ? "\\x" + point.toString(16).padStart(2, "0")
              : point <= 0xffff
                ? "\\u" + point.toString(16).padStart(4, "0")
                : "\\U" + point.toString(16).padStart(8, "0");
          }
          return character;
        })
        .join("") +
      quote
    );
  }
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    const serialized = JSON.stringify(value);
    if (serialized === "null") return "None";
    return value !== 0 && Math.abs(value) < 0.0001
      ? value
          .toExponential()
          .replace(
            /e([+-])(\d)$/u,
            (_match, sign: string, digit: string) => `e${sign}0${digit}`,
          )
      : serialized;
  }
  if (Array.isArray(value))
    return "[" + value.map((item) => display(item, true)).join(", ") + "]";
  if (isRecord(value))
    return (
      "{" +
      Object.entries(value)
        .map(([key, item]) => `${display(key, true)}: ${display(item, true)}`)
        .join(", ") +
      "}"
    );
  throw new TypeError("Threat-model presentation requires JSON values.");
}

function markdownContent(model: Record<string, unknown>): string | undefined {
  return model.format === "markdown" &&
    typeof model.content === "string" &&
    nonblank(model.content)
    ? model.content
    : undefined;
}

function body(model: Record<string, unknown>): string {
  const markdown = markdownContent(model);
  const structured = shapes.schema.options[0].safeParse(model);
  if (markdown !== undefined) {
    // Structured models permit legacy metadata as extension fields.
    if (!structured.success) validateMarkdownMetadata(model);
    return markdown;
  }
  if (!structured.success) {
    const [key, index] = structured.error.issues[0]!.path;
    if (key === "summary")
      throw new Error(
        model.format === "markdown"
          ? "threatModel.content: expected non-empty Markdown"
          : "threatModel.summary: expected a non-empty string",
      );
    throw new Error(
      index === undefined
        ? `threatModel.${String(key)}: expected an array`
        : `threatModel.${String(key)}[${String(index)}]: expected a non-empty string`,
    );
  }
  const { summary } = structured.data;
  const result = [
    nonblank(summary)
      ? summary
      : "No explicit canonical threat-model summary was recorded.",
  ];
  for (const [heading, key] of sections) {
    const values = structured.data[key];
    if (values?.length)
      result.push(
        `## ${heading}`,
        values.map((value) => "- " + value.replaceAll("\n", "\n  ")).join("\n"),
      );
  }
  return "# Threat Model\n\n" + result.join("\n\n");
}

function validateMarkdownMetadata(model: Record<string, unknown>): void {
  // Keep the retained renderer's field order and diagnostics while sharing the
  // authored-tool schema.
  if (!shapes.markdown.shape.origin.safeParse(model.origin).success)
    throw new Error("threatModel.origin: unsupported value");
  if (!("scope" in model)) return;
  const scope = model.scope;
  if (!isRecord(scope) || !("includePaths" in scope))
    throw new Error("threatModel.scope: expected an object with includePaths");
  const parsed = shapes.scope.safeParse(scope);
  if (!parsed.success) {
    const key = parsed.error.issues[0]!.path[0];
    throw new Error(
      key === "summary"
        ? "threatModel.scope.summary: expected a non-empty string"
        : `threatModel.scope.${String(key)}: expected an array of non-empty strings`,
    );
  }
}

function scopeLines(scope: unknown, label: string): string[] {
  if (
    !isRecord(scope) ||
    !Array.isArray(scope.includePaths) ||
    !scope.includePaths.every((path) => typeof path === "string")
  ) {
    return [`- ${label}: not recorded`];
  }
  const lines = [`- ${label}: ${text(scope.includePaths.join(", "), "none")}`];
  if (
    Array.isArray(scope.excludePaths) &&
    scope.excludePaths.length &&
    scope.excludePaths.every((path) => typeof path === "string")
  ) {
    lines.push(
      `- ${label} exclusions: ${text(scope.excludePaths.join(", "), "none")}`,
    );
  }
  if (typeof scope.summary === "string" && scope.summary)
    lines.push(
      `- ${label} description: ${text(scope.summary, "not recorded")}`,
    );
  return lines;
}

export function renderThreatModel(input: ThreatModelRenderInput): string {
  const model = input.threatModel;
  if (!isRecord(model)) throw new Error("threatModel: expected an object");
  const provenance = input.provenance ?? {};
  const rendered = body(model);
  const footer = ["---", "", "## Saved Model Context", ""];
  for (const [key, label] of fields) {
    const value = truthy(provenance[key])
      ? display(provenance[key])
      : undefined;
    if (value !== undefined)
      footer.push(`- ${label}: ${text(value, "not recorded")}`);
  }
  footer.push(`- Model origin: ${text(model.origin, "not recorded")}`);
  footer.push(...scopeLines(model.scope, "Model scope"));
  if (isRecord(provenance.scanScope))
    footer.push(...scopeLines(provenance.scanScope, "Scan scope"));
  if (truthy(provenance.provisional))
    footer.push(
      "",
      "This is a provisional model saved before successful completion.",
    );
  const result =
    rendered +
    (rendered.endsWith("\n") ? "\n" : "\n\n") +
    footer.join("\n") +
    "\n";
  if (!result.isWellFormed()) {
    throw new Error(
      "Threat-model Markdown contains an unpaired Unicode surrogate",
    );
  }
  return result;
}

import type * as z from "zod/v4";
import { isAbsolute, posix } from "node:path";
import commonSchema from "../../schemas/definitions/artifact-common.schema.json";
import scanDraftDocument from "../../schemas/tools/scan-draft.schema.json";
import scanManifestDocument from "../../schemas/scan-manifest.schema.json";
import coverageDocument from "../../schemas/coverage.schema.json";
import findingsDocument from "../../schemas/findings.schema.json";
import { isRecord as isObject, isNonEmptyString } from "./record.js";
import {
  loadArtifactZodSchema,
  type SchemaDocument,
} from "./artifact-schema-loader.js";
import {
  requireObject,
  validateFindingSemantics,
  validateCoverageSemantics,
  type SemanticScan,
} from "../../../../sdk/typescript/src/scan-semantics.js";
type JsonObject = Record<string, unknown>;
type ScanDraftInput = SemanticScan;
const canonicalScanDraftInputSchema = loadArtifactZodSchema(
  [
    commonSchema,
    {
      ...scanDraftDocument,
      $defs: {
        ...scanManifestDocument.$defs,
        ...findingsDocument.$defs,
        ...scanDraftDocument.$defs,
        scanId: scanManifestDocument.properties.scan.properties.id,
        scope: {
          ...scanDraftDocument.$defs.scope,
          properties:
            scanManifestDocument.properties.scan.properties.scope.properties,
        },
        threatModel:
          scanManifestDocument.properties.scan.properties.threatModel,
        finding: {
          ...scanDraftDocument.$defs.finding,
          properties: findingsDocument.properties.findings.items.properties,
        },
        coverage: {
          ...scanDraftDocument.$defs.coverage,
          properties: {
            ...coverageDocument.properties,
            surfaces: {
              ...coverageDocument.properties.surfaces,
              items: {
                ...coverageDocument.properties.surfaces.items,
                required: scanDraftDocument.$defs.surface.required,
              },
            },
            deferred: {
              ...coverageDocument.properties.deferred,
              items: {
                ...coverageDocument.properties.deferred.items,
                required:
                  scanDraftDocument.$defs.coverage.properties.deferred.items
                    .required,
              },
            },
            // String questions are normalized by the finalizer after admission.
            openQuestions: {
              ...coverageDocument.properties.openQuestions,
              items: {
                anyOf: [
                  scanDraftDocument.$defs.coverage.properties.openQuestions
                    .items.anyOf[0],
                  coverageDocument.properties.openQuestions.items,
                ],
              },
            },
          },
        },
      },
    },
  ] as SchemaDocument[],
  scanDraftDocument.$id,
  "scanDraftInput",
) as z.ZodType<ScanDraftInput>;

function safeRelativePath(value: string, context: string): string {
  const parts = value.split("/");
  if (
    value.trim().length === 0 ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    value === "." ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    parts.includes("..") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw new Error(`${context}: expected a safe scan-relative POSIX path.`);
  }
  const normalized = posix.normalize(value).replace(/\/+$/, "");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    isAbsolute(normalized)
  ) {
    throw new Error(`${context}: expected a safe scan-relative POSIX path.`);
  }
  return normalized;
}

export function parseCanonicalScanDraft(input: {
  scanId?: string;
  manifest: JsonObject;
  findings: JsonObject;
  coverage: JsonObject;
}): ScanDraftInput {
  const scan = requireObject(input.manifest.scan, "scan draft manifest.scan");
  for (const scanId of [
    scan.id,
    input.findings.scanId,
    input.coverage.scanId,
  ]) {
    if (scanId !== undefined && scanId !== input.scanId) {
      throw new Error(
        "scan draft: canonical documents belong to a different scan.",
      );
    }
  }
  return parseCanonicalCheckpoint({
    scanId: input.scanId,
    ...(scan.complete === undefined ? {} : { complete: scan.complete }),
    ...(scan.scope === undefined ? {} : { scope: scan.scope }),
    ...(scan.threatModel === undefined
      ? {}
      : { threatModel: scan.threatModel }),
    findings: input.findings.findings,
    coverage: input.coverage,
  });
}

export function parseCanonicalCheckpoint(
  input: Record<string, unknown>,
): ScanDraftInput {
  const parsed = parsePersistedCheckpoint(input, canonicalScanDraftInputSchema);
  for (const [index, finding] of parsed.findings.entries()) {
    for (const field of ["locations", "codeEvidence"] as const) {
      for (const [locationIndex, location] of (
        (finding[field] as JsonObject[] | undefined) ?? []
      ).entries()) {
        safeRelativePath(
          location.path as string,
          `findings[${index}].${field}[${locationIndex}].path`,
        );
      }
    }
  }
  return parsed;
}

function parsePersistedCheckpoint(
  input: Record<string, unknown>,
  schema = canonicalScanDraftInputSchema,
): ScanDraftInput {
  const compatible = structuredClone(input);
  if (isObject(compatible.scope)) {
    delete compatible.scope.includePaths;
    delete compatible.scope.excludePaths;
    if (Object.keys(compatible.scope).length === 0) delete compatible.scope;
  }
  if (isObject(compatible.coverage)) {
    for (const field of [
      "documentType",
      "schemaVersion",
      "scanId",
      "mode",
      "includePaths",
      "excludePaths",
      "receiptRefs",
      "inventoryStrategy",
    ])
      delete compatible.coverage[field];
  }
  if (Array.isArray(compatible.findings)) {
    for (const finding of compatible.findings) {
      if (!isObject(finding)) continue;
      delete finding.findingId;
      delete finding.occurrenceId;
      delete finding.fingerprints;
    }
  }
  if (Array.isArray(compatible.findings)) {
    for (const finding of compatible.findings) {
      if (isObject(finding)) normalizePersistedFindingDetails(finding);
    }
  }
  const parsed = schema.parse(compatible);
  validateFindingSemantics(parsed.findings, false);
  validateCoverageSemantics(parsed.coverage);
  return parsed;
}

function normalizePersistedFindingDetails(finding: JsonObject): void {
  const canonicalEvidence = Array.isArray(finding.codeEvidence)
    ? finding.codeEvidence
    : [];
  const evidenceIds = new Set(
    canonicalEvidence.flatMap((evidence) => {
      if (!isObject(evidence)) return [];
      const id = evidence.id;
      return isNonEmptyString(id) ? [id] : [];
    }),
  );
  if (Array.isArray(finding.code_evidence)) {
    const compatibleEvidence: JsonObject[] = [];
    for (const evidence of finding.code_evidence) {
      if (!isObject(evidence)) continue;
      const id = evidence.id;
      const code = evidence.code;
      if (
        !isNonEmptyString(id) ||
        !isNonEmptyString(code) ||
        evidenceIds.has(id)
      ) {
        continue;
      }
      evidenceIds.add(id);
      compatibleEvidence.push(evidence);
    }
    finding.code_evidence = compatibleEvidence;
  } else if ("code_evidence" in finding) {
    delete finding.code_evidence;
  }

  for (const [sectionName, listFields] of [
    ["rootCause", ["evidenceRefs", "evidence_refs"]],
    ["root_cause", ["evidenceRefs", "evidence_refs"]],
    [
      "validation",
      [
        "assertions",
        "counterEvidence",
        "evidence",
        "evidenceRefs",
        "evidence_refs",
        "limitations",
      ],
    ],
    [
      "attackPath",
      [
        "assumptions",
        "blindspots",
        "controls",
        "evidenceRefs",
        "evidence_refs",
        "limitations",
        "preconditions",
        "steps",
      ],
    ],
  ] satisfies Array<[string, string[]]>) {
    const section = finding[sectionName];
    if (!isObject(section)) continue;
    normalizePersistedStringLists(section, listFields);
  }

  const rootCause = finding.rootCause;
  if (isObject(rootCause)) {
    if (!isNonEmptyString(rootCause.summary)) {
      delete finding.rootCause;
    } else {
      removeUnsupportedPersistedStrings(rootCause, ["code", "language"]);
    }
  }
  const legacyRootCause = finding.root_cause;
  if (isObject(legacyRootCause)) {
    removeUnsupportedPersistedStrings(legacyRootCause, [
      "summary",
      "code",
      "language",
    ]);
  } else if ("root_cause" in finding && !isNonEmptyString(legacyRootCause)) {
    delete finding.root_cause;
  }

  const validation = finding.validation;
  if (isObject(validation)) {
    removeUnsupportedPersistedStrings(validation, [
      "method",
      "status",
      "summary",
      "disposition",
      "result",
    ]);
  }

  const attackPath = finding.attackPath;
  if (!isObject(attackPath)) return;
  removeUnsupportedPersistedStrings(attackPath, ["summary"]);
  for (const field of ["dataFlow", "data_flow", "dataflow", "reachability"]) {
    const detail = attackPath[field];
    if (!isObject(detail)) {
      if (!isNonEmptyString(detail)) delete attackPath[field];
      continue;
    }
    removeUnsupportedPersistedStrings(detail, [
      "summary",
      "source",
      "sink",
      "outcome",
      ...(field === "reachability" ? ["attacker", "entrypoint"] : []),
    ]);
    normalizePersistedStringLists(detail, [
      "evidenceRefs",
      "evidence_refs",
      "transformations",
      ...(field === "reachability" ? ["preconditions"] : []),
    ]);
  }
  for (const field of ["impact", "likelihood"]) {
    const detail = attackPath[field];
    if (isObject(detail)) {
      removeUnsupportedPersistedStrings(detail, ["level", "rationale", "why"]);
    } else if (
      detail !== undefined &&
      detail !== null &&
      !isNonEmptyString(detail)
    ) {
      delete attackPath[field];
    }
  }

  function normalizePersistedStringLists(
    section: JsonObject,
    fields: string[],
  ): void {
    for (const field of fields) {
      if (!(field in section)) continue;
      const value = section[field];
      const normalized = isNonEmptyString(value)
        ? [value]
        : Array.isArray(value)
          ? value.filter(isNonEmptyString)
          : [];
      if (normalized.length > 0) section[field] = normalized;
      else delete section[field];
    }
    for (const field of ["evidenceRefs", "evidence_refs"]) {
      const refs = section[field];
      if (!Array.isArray(refs)) continue;
      section[field] = refs.filter((ref) => evidenceIds.has(ref));
    }
  }
}

function removeUnsupportedPersistedStrings(
  section: JsonObject,
  fields: string[],
): void {
  for (const field of fields) {
    if (field in section && !isNonEmptyString(section[field])) {
      delete section[field];
    }
  }
}

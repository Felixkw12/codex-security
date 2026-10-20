import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadContract } from "../src/contract.js";
import type {
  CoverageDocument,
  Finding,
  FindingsDocument,
  ScanManifest,
} from "../src/models.js";
import { copyCompletedScan, PLUGIN_ROOT } from "./plugin-root.js";
import { sha256 } from "./support/finding-identity.js";
import { readJson, writeJson } from "./support/json.js";
import { createApiTestFixtures } from "./support/temporary-directories.js";

const fixtures = createApiTestFixtures("sealed-contract-validation-");
afterEach(fixtures.cleanup);
const { validateTrackingSource } = (
  await import(pathToFileURL(join(PLUGIN_ROOT, "mcp", "helpers.mjs")).href)
).default as {
  validateTrackingSource(scanDir: string): Promise<Finding[]>;
};

type Documents = {
  scanDir: string;
  manifest: ScanManifest;
  findings: FindingsDocument;
  coverage: CoverageDocument;
};

async function fixture(): Promise<Documents> {
  const scanDir = await copyCompletedScan(await fixtures.temporaryDirectory());
  return {
    scanDir,
    manifest: await readJson<ScanManifest>(join(scanDir, "scan-manifest.json")),
    findings: await readJson<FindingsDocument>(join(scanDir, "findings.json")),
    coverage: await readJson<CoverageDocument>(join(scanDir, "coverage.json")),
  };
}

async function saveAndSeal(documents: Documents, findingsText?: string) {
  const { scanDir, manifest, findings, coverage } = documents;
  await writeFile(
    join(scanDir, "findings.json"),
    findingsText ?? JSON.stringify(findings),
  );
  await writeJson(join(scanDir, "coverage.json"), coverage);
  for (const artifact of manifest.scan.artifacts) {
    artifact.sha256 = sha256(await readFile(join(scanDir, artifact.path)));
  }
  await writeJson(join(scanDir, "scan-manifest.json"), manifest);
}

const evidence = {
  id: "proof",
  label: "Proof",
  path: "src/example.ts",
  startLine: 41,
  endLine: 41,
  code: "example()",
  explanation: "Synthetic evidence.",
} satisfies NonNullable<Finding["codeEvidence"]>[number];

const invalidCases: Array<[string, (documents: Documents) => void, string]> = [
  [
    "duplicate canonical evidence",
    ({ findings }) => {
      findings.findings[0]!.codeEvidence = [evidence, { ...evidence }];
    },
    "duplicate code-evidence id",
  ],
  [
    "blank canonical evidence code",
    ({ findings }) => {
      findings.findings[0]!.codeEvidence = [{ ...evidence, code: " \u001c" }];
    },
    ".code: expected a non-empty string",
  ],
  [
    "duplicate coverage surface",
    ({ coverage }) => {
      coverage.surfaces.push({ ...coverage.surfaces[0]! });
    },
    "duplicate surface id",
  ],
  [
    "blank coverage surface label",
    ({ coverage }) => {
      coverage.surfaces[0]!.label = " ";
    },
    ".label: expected a non-empty string",
  ],
  [
    "duplicate resolved work",
    ({ coverage }) => {
      coverage.resolvedDeferred = [
        { id: "task", reason: "Done." },
        { id: "task", reason: "Also done." },
      ];
    },
    "duplicate resolved deferred id",
  ],
  [
    "resolved work that remains active",
    ({ coverage }) => {
      coverage.deferred = [{ id: "task", reason: "Pending." }];
      coverage.resolvedDeferred = [{ id: "task", reason: "Done." }];
    },
    "deferred work is still active",
  ],
  [
    "resolved candidate that remains active",
    ({ coverage }) => {
      coverage.deferred = [
        { id: "task", candidateId: "candidate", reason: "Pending." },
      ];
      coverage.resolvedDeferred = [{ id: "candidate", reason: "Done." }];
    },
    "deferred work is still active",
  ],
  [
    "blank resolution reason",
    ({ coverage }) => {
      coverage.resolvedDeferred = [{ id: "task", reason: " " }];
    },
    ".reason: expected a non-empty string",
  ],
  [
    "blank producer",
    ({ manifest }) => {
      manifest.scan.producer.name = " ";
    },
    ".producer.name: expected a non-empty string",
  ],
  [
    "empty revision on a revision target",
    ({ manifest }) => {
      manifest.scan.target.kind = "git_revision";
      manifest.scan.target.revision = "";
    },
    ".revision: expected a non-empty string",
  ],
  [
    "remote control characters normalized by URL parsing",
    ({ manifest }) => {
      manifest.scan.target.remote = "https://example.com\t/repository";
    },
    "expected a sanitized canonical absolute URL",
  ],
  [
    "noncanonical fingerprint properties",
    ({ findings }) => {
      findings.findings[0]!.fingerprints["extra"] = "synthetic";
    },
    "does not match derived fingerprint",
  ],
  [
    "Unicode drive-like repository paths",
    ({ findings }) => {
      findings.findings[0]!.locations[0]!.path = "é:file";
    },
    "safe repository-relative POSIX path",
  ],
  [
    "a threat model containing only a next-line character",
    ({ manifest }) => {
      manifest.scan.threatModel = { format: "markdown", content: "\u0085" };
    },
    "scan-manifest.json",
  ],
];

test.each(invalidCases)(
  "rejects tracking %s while preserving the SDK read behavior",
  async (_name, mutate, message) => {
    const documents = await fixture();
    mutate(documents);
    await saveAndSeal(documents);
    expect(
      (await loadContract(documents.scanDir, { pluginRoot: PLUGIN_ROOT }))
        .findings,
    ).toEqual(documents.findings);
    await expect(validateTrackingSource(documents.scanDir)).rejects.toThrow(
      message,
    );
  },
);

const historicalTrackingCases: Array<
  [string, (documents: Documents) => void, string]
> = [
  [
    "a localhost file remote",
    ({ manifest }) => {
      manifest.scan.target.remote = "file://localhost/repo";
    },
    "expected a sanitized canonical absolute URL",
  ],
  [
    "a file remote with a port",
    ({ manifest }) => {
      manifest.scan.target.remote = "file://example.com:123/repo";
    },
    "expected a sanitized canonical absolute URL",
  ],
  [
    "a scoped IPv6 remote",
    ({ manifest }) => {
      manifest.scan.target.remote = "ssh://[fe80::1%25eth0]/repo";
    },
    "expected a sanitized canonical absolute URL",
  ],
  [
    "overflowing timezone minutes",
    ({ manifest }) => {
      manifest.scan.startedAt = "2026-01-02T03:04:05+00:60";
    },
    'must match format "date-time"',
  ],
  [
    "a canonical evidence ID with a final newline",
    ({ findings }) => {
      findings.findings[0]!.codeEvidence = [{ ...evidence, id: "proof\n" }];
    },
    "must match pattern",
  ],
  [
    "a discarded legacy surrogate",
    ({ findings }) => {
      const finding = findings.findings[0]! as Record<string, unknown>;
      finding["code_evidence"] = "\ud800";
    },
    "expected well-formed Unicode JSON strings",
  ],
  [
    "a surrogate in discarded duplicate legacy evidence",
    ({ findings }) => {
      findings.findings[0]!.code_evidence = [
        { id: "legacy", code: "example()" },
        { id: "legacy", code: "duplicate()", discarded: "\ud800" },
      ];
    },
    "expected well-formed Unicode JSON strings",
  ],
  [
    "a surrogate in a discarded unknown evidence reference",
    ({ findings }) => {
      findings.findings[0]!.rootCause = {
        summary: "Synthetic cause.",
        evidenceRefs: ["\ud800"],
      };
    },
    "expected well-formed Unicode JSON strings",
  ],
  [
    "a snapshot digest with a final newline",
    ({ manifest }) => {
      manifest.scan.target.snapshotDigest += "\n";
    },
    "must match pattern",
  ],
  [
    "an optional writeup path with a final newline",
    ({ findings }) => {
      findings.findings[0]!.writeup = {
        reportPath: "findings/proof/proof.md\n",
      };
    },
    "must match pattern",
  ],
  [
    "a threat model containing a byte-order-mark character",
    ({ manifest }) => {
      manifest.scan.threatModel = { format: "markdown", content: "\ufeff" };
    },
    "scan-manifest.json",
  ],
];

test.each(historicalTrackingCases)(
  "preserves tracking admission of %s and the SDK rejection",
  async (_name, mutate, message) => {
    const documents = await fixture();
    mutate(documents);
    await saveAndSeal(documents);
    const paths = ["scan-manifest.json", "findings.json", "coverage.json"];
    const before = await Promise.all(
      paths.map((path) => readFile(join(documents.scanDir, path))),
    );
    await expect(
      loadContract(documents.scanDir, { pluginRoot: PLUGIN_ROOT }),
    ).rejects.toThrow(message);
    expect(
      (await validateTrackingSource(documents.scanDir)).map(
        (finding) => finding.findingId,
      ),
    ).toEqual(documents.findings.findings.map((finding) => finding.findingId));
    expect(
      await Promise.all(
        paths.map((path) => readFile(join(documents.scanDir, path))),
      ),
    ).toEqual(before);
  },
);

test.each([
  "ssh://[fe80::1%]/repo",
  "ssh://[fe80::1%a%b]/repo",
  "ssh://[fe80::1%a b]/repo",
  "ssh://[fe80::1%a@b]/repo",
  "ssh://[fe80::1%a?b]/repo",
  "ssh://[fe80::1%a/b]/repo",
  "ssh://[fe80::1%a\\b]/repo",
  "ssh://[fe80::1%a\u0085b]/repo",
  "ssh://[not-ip%zone]/repo",
  "file://example.com:65536/repo",
])("retains rejection of invalid remote %s", async (remote) => {
  const documents = await fixture();
  documents.manifest.scan.target.remote = remote;
  await saveAndSeal(documents);
  await expect(
    loadContract(documents.scanDir, { pluginRoot: PLUGIN_ROOT }),
  ).rejects.toThrow();
  await expect(validateTrackingSource(documents.scanDir)).rejects.toThrow();
});

test.each([
  "2026-01-02T03:04:05+23:60",
  "2026-01-02T03:04:05-23:60",
  "2026-01-02T03:04:05+99:99",
  "2026-02-30T03:04:05+00:60",
])("retains rejection of invalid timestamp %s", async (timestamp) => {
  const documents = await fixture();
  documents.manifest.scan.startedAt = timestamp;
  await saveAndSeal(documents);
  await expect(
    loadContract(documents.scanDir, { pluginRoot: PLUGIN_ROOT }),
  ).rejects.toThrow('must match format "date-time"');
  await expect(validateTrackingSource(documents.scanDir)).rejects.toThrow(
    'must match format "date-time"',
  );
});

test.each(["ruleId", "anchor", "instance"] as const)(
  "retains rejection of a final newline in identity slug %s",
  async (field) => {
    const documents = await fixture();
    const finding = documents.findings.findings[0]!;
    if (field === "ruleId") finding.ruleId = "proof\n";
    else finding.identity[field] = "proof\n";
    await saveAndSeal(documents);
    await expect(
      loadContract(documents.scanDir, { pluginRoot: PLUGIN_ROOT }),
    ).rejects.toThrow("must match pattern");
    await expect(validateTrackingSource(documents.scanDir)).rejects.toThrow(
      "must match pattern",
    );
  },
);

test("rejects invalid Unicode retained in canonical evidence", async () => {
  const documents = await fixture();
  documents.findings.findings[0]!.codeEvidence = [
    { ...evidence, code: "\ud800" },
  ];
  await saveAndSeal(documents);
  await expect(
    loadContract(documents.scanDir, { pluginRoot: PLUGIN_ROOT }),
  ).rejects.toThrow("expected well-formed Unicode JSON strings");
  await expect(validateTrackingSource(documents.scanDir)).rejects.toThrow(
    "expected well-formed Unicode JSON strings",
  );
});

test("requires both canonical artifact seals", async () => {
  const documents = await fixture();
  for (const required of ["findings.json", "coverage.json"]) {
    const manifest = structuredClone(documents.manifest);
    manifest.scan.artifacts = manifest.scan.artifacts.filter(
      ({ path }) => path !== required,
    );
    await writeJson(join(documents.scanDir, "scan-manifest.json"), manifest);
    await expect(
      loadContract(documents.scanDir, { pluginRoot: PLUGIN_ROOT }),
    ).rejects.toThrow("scan-manifest.json");
  }
});

for (const group of ["locations", "codeEvidence"] as const) {
  for (const field of ["startLine", "endLine"] as const) {
    test.each(["41.0", "41e0"])(
      `rejects tracking ${group}.${field} encoded as %s while preserving SDK reads`,
      async (token) => {
        const documents = await fixture();
        const finding = documents.findings.findings[0]!;
        finding.locations = [
          { path: "src/example.ts", startLine: 41, endLine: 41 },
        ];
        finding.codeEvidence = [{ ...evidence }];
        finding[group]![0]![field] = 123456;
        const raw = JSON.stringify(documents.findings).replace(
          `"${field}":123456`,
          `"${field}":${token}`,
        );
        await saveAndSeal(documents, raw);
        expect(
          (await loadContract(documents.scanDir, { pluginRoot: PLUGIN_ROOT }))
            .findings,
        ).toEqual(JSON.parse(raw));
        await expect(validateTrackingSource(documents.scanDir)).rejects.toThrow(
          "expected an integer JSON number",
        );
      },
    );
  }
}

test("preserves permissive historical details and ordinary decimal values", async () => {
  const documents = await fixture();
  const finding = documents.findings.findings[0]!;
  finding.code_evidence = [
    { id: "legacy", code: "example()" },
    { id: "legacy", code: "duplicate()" },
    { id: " ", code: " " },
  ];
  finding.attackPath = { dataFlow: { evidenceRefs: ["missing"] } };
  finding.extensions = { startLine: 41.5, endLine: 42.0 };
  finding.severity.score = 5;
  finding.severity.scoringSystem = "Synthetic";
  const raw = JSON.stringify(documents.findings).replace(
    '"score":5',
    '"score":5.0',
  );
  await saveAndSeal(documents, raw);
  const loaded = await loadContract(documents.scanDir, {
    pluginRoot: PLUGIN_ROOT,
  });
  expect(loaded.findings.findings[0]!.code_evidence).toEqual(
    finding.code_evidence,
  );
  expect(loaded.findings.findings[0]!.attackPath).toEqual(finding.attackPath);
  expect(
    (await validateTrackingSource(documents.scanDir)).map(
      (finding) => finding.findingId,
    ),
  ).toEqual(documents.findings.findings.map((finding) => finding.findingId));
  expect(await readFile(join(documents.scanDir, "findings.json"), "utf8")).toBe(
    raw,
  );
});

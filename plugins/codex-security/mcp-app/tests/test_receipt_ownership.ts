import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importSource } from "./import-module.ts";
import { scanId, workerDraft } from "./scan-draft-fixture.ts";
import { temporaryDirectory } from "./support/temporary-directories.ts";

const { readDeepReductionSources } = await importSource(
  path.join(import.meta.dirname, "../src/artifact-deep-reducer.ts"),
);
const { recordCodexSecurityWorkerScanDraft } = await importSource(
  path.join(import.meta.dirname, "../src/artifact-scan-draft.ts"),
);

const { archiveDirectory } = await importSource(
  path.join(import.meta.dirname, "../src/deep-scan/artifacts.ts"),
);

async function fixture() {
  const root = await temporaryDirectory("receipt-ownership-", true);
  const prefix = "artifacts/deep_discovery/workers/discovery-0001/output";
  const workerRoot = path.join(root, prefix);
  const reducerRoot = path.join(
    root,
    "artifacts/deep_discovery/dedup/run/output",
  );
  await mkdir(workerRoot, { recursive: true });
  await mkdir(reducerRoot, { recursive: true });
  return {
    root,
    prefix,
    workerRoot,
    worker: { root: workerRoot, repoRoot: root, scanId, layout: "worker" },
    reducer: {
      root: reducerRoot,
      repoRoot: root,
      scanId,
      layout: "reducer",
      deepReducer: {
        scanRoot: root,
        claimedWorkers: [
          { id: "worker-1", resultPath: path.join(workerRoot, "result.json") },
        ],
      },
    },
  };
}

function draft(receiptRefs: string[], extra = {}) {
  return workerDraft([], {
    coverage: {
      ...workerDraft([]).coverage,
      surfaces: [
        {
          id: "reviewed-route",
          label: "Reviewed route",
          disposition: "no_issue_found",
          receiptRefs,
          ...extra,
        },
      ],
    },
  });
}

async function receipt(root: string, ref: string, contents: string) {
  await mkdir(path.dirname(path.join(root, ref)), { recursive: true });
  await writeFile(path.join(root, ref), contents);
}

function recoverCoverage(
  f: Awaited<ReturnType<typeof fixture>>,
  complete = true,
  attempt = 1,
) {
  return JSON.parse(
    execFileSync(
      process.env.PYTHON || "python3",
      [
        "-B",
        "-c",
        `
import json, sys
from pathlib import Path
plugin, root, active = map(Path, sys.argv[1:4])
scan_id, complete = sys.argv[4], sys.argv[5] == "true"
sys.path[:0] = [str(plugin / "scripts"), str(plugin / "tests")]
from workbench_saved_results import merge_saved_results
from workbench_test_support import saved_binding, saved_discovery_worker
from finalize_scan_contract import _recover_unsealed_coverage
worker = {**saved_discovery_worker(active, "worker-1", int(sys.argv[6])), "status": "succeeded" if complete else "running", "result_manifest_path": str(active / "result.json") if complete else None}
binding = saved_binding("deep_repository")
binding["target"].update(targetId="synthetic", displayName="Synthetic repository")
args = (root, scan_id, binding, [worker], [])
merged = merge_saved_results(*args, stopped=True, reason="interrupted")
replay = merge_saved_results(*args, stopped=True, reason="interrupted", frozen_source_digests=merged[0]["scan"]["preservedSources"])
assert merged[2] == replay[2]
refs = merged[2]["surfaces"][0]["receiptRefs"]
warnings = []
coverage = merged[2]
_recover_unsealed_coverage(coverage, plugin / "schemas", root, warnings, [])
print(json.dumps({"refs": refs, "surfaces": coverage["surfaces"], "warnings": warnings}))
`,
        path.resolve(import.meta.dirname, "../.."),
        f.root,
        f.workerRoot,
        scanId,
        String(complete),
        String(attempt),
      ],
      { encoding: "utf8" },
    ),
  );
}

for (const sharedExists of [false, true]) {
  test(`direct worker provenance cannot change local receipt ownership (shared exists: ${sharedExists})`, async () => {
    const f = await fixture();
    try {
      const ref = "artifacts/evidence.txt";
      await receipt(f.workerRoot, ref, "Local evidence\n");
      if (sharedExists)
        await receipt(f.root, ref, "Unrelated shared evidence\n");
      await writeFile(
        path.join(f.workerRoot, "result.json"),
        JSON.stringify(
          draft([ref], { provenance: { scanReceiptRefs: [ref] } }),
        ),
      );
      const sources = await readDeepReductionSources(f.reducer);
      const [projected] = sources.discoveries[0].coverage.surfaces;
      assert.deepEqual(projected.receiptRefs, [`${f.prefix}/${ref}`]);
      assert.equal(
        await readFile(path.join(f.root, projected.receiptRefs[0]), "utf8"),
        "Local evidence\n",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("direct worker receipts fall back to an existing shared file without a local receipt", async () => {
  const f = await fixture();
  try {
    const ref = "artifacts/evidence.txt";
    await receipt(f.root, ref, "Shared evidence\n");
    await writeFile(
      path.join(f.workerRoot, "result.json"),
      JSON.stringify(draft([ref])),
    );
    const sources = await readDeepReductionSources(f.reducer);
    assert.deepEqual(sources.discoveries[0].coverage.surfaces[0].receiptRefs, [
      ref,
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const update of ["notes", "receipt order"] as const) {
  test(`retained shared ownership survives changed ${update} and a local collision`, async () => {
    const f = await fixture();
    try {
      const refs = ["artifacts/first.txt", "artifacts/second.txt"];
      for (const ref of refs) await receipt(f.root, ref, "Shared evidence\n");
      await recordCodexSecurityWorkerScanDraft(f.worker, draft(refs));
      for (const ref of refs)
        await receipt(f.workerRoot, ref, "Unrelated local evidence\n");
      await recordCodexSecurityWorkerScanDraft(
        f.worker,
        draft(
          update === "receipt order" ? [...refs].reverse() : refs,
          update === "notes" ? { notes: "Updated review notes." } : {},
        ),
      );
      const sources = await readDeepReductionSources(f.reducer);
      const [projected] = sources.discoveries[0].coverage.surfaces;
      assert.deepEqual([...projected.receiptRefs].sort(), [...refs].sort());
      for (const ref of projected.receiptRefs)
        assert.equal(
          await readFile(path.join(f.root, ref), "utf8"),
          "Shared evidence\n",
        );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const changed of ["result provenance", "checkpoint contents"] as const) {
  test(`saved ownership requires the exact checkpoint payload after changed ${changed}`, async () => {
    const f = await fixture();
    try {
      const ref = "artifacts/evidence.txt";
      await receipt(f.root, ref, "Shared evidence\n");
      await recordCodexSecurityWorkerScanDraft(f.worker, draft([ref]));
      await receipt(f.workerRoot, ref, "Local evidence\n");
      const resultPath = path.join(f.workerRoot, "result.json");
      if (changed === "result provenance") {
        const saved = JSON.parse(await readFile(resultPath, "utf8"));
        saved.coverage.surfaces[0].provenance.extra =
          "Directly authored extension";
        await writeFile(resultPath, JSON.stringify(saved));
      } else {
        const checkpointRoot = path.join(f.workerRoot, "checkpoints");
        for (const name of await readdir(checkpointRoot)) {
          const checkpoint = path.join(checkpointRoot, name);
          const saved = JSON.parse(await readFile(checkpoint, "utf8"));
          saved.coverage.surfaces[0].provenance.extra = "Changed checkpoint";
          await writeFile(checkpoint, JSON.stringify(saved));
        }
      }
      const sources = await readDeepReductionSources(f.reducer);
      assert.deepEqual(
        sources.discoveries[0].coverage.surfaces[0].receiptRefs,
        [`${f.prefix}/${ref}`],
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("a retained surface keeps only retained shared references and resolves new receipts locally", async () => {
  const f = await fixture();
  try {
    const retained = "artifacts/retained.txt";
    const removed = "artifacts/removed.txt";
    const added = "artifacts/added.txt";
    for (const ref of [retained, removed, added])
      await receipt(f.root, ref, "Shared evidence\n");
    await recordCodexSecurityWorkerScanDraft(
      f.worker,
      draft([retained, removed]),
    );
    for (const ref of [retained, added])
      await receipt(f.workerRoot, ref, "Local evidence\n");
    const result = await recordCodexSecurityWorkerScanDraft(
      f.worker,
      draft([retained, added], { notes: "Updated review." }),
    );
    assert.deepEqual(result.coverage.surfaces[0].provenance.scanReceiptRefs, [
      retained,
    ]);
    const sources = await readDeepReductionSources(f.reducer);
    assert.deepEqual(sources.discoveries[0].coverage.surfaces[0].receiptRefs, [
      retained,
      `${f.prefix}/${added}`,
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ambiguous saved surface IDs do not transfer shared ownership to an edited observation", async () => {
  const f = await fixture();
  try {
    const ref = "artifacts/evidence.txt";
    await receipt(f.root, ref, "Shared evidence\n");
    await recordCodexSecurityWorkerScanDraft(f.worker, draft([ref]));
    const resultPath = path.join(f.workerRoot, "result.json");
    const previous = JSON.parse(await readFile(resultPath, "utf8"));
    previous.coverage.surfaces.push({
      ...previous.coverage.surfaces[0],
      label: "Separate review with a reused ID",
    });
    await writeFile(resultPath, JSON.stringify(previous));
    await receipt(f.workerRoot, ref, "Local evidence\n");
    await recordCodexSecurityWorkerScanDraft(
      f.worker,
      draft([ref], { notes: "Updated review." }),
    );
    const sources = await readDeepReductionSources(f.reducer);
    const edited = sources.discoveries[0].coverage.surfaces.find(
      (surface: { notes?: string }) => surface.notes === "Updated review.",
    );
    assert.deepEqual(edited.receiptRefs, [`${f.prefix}/${ref}`]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const archived of [false, true]) {
  test(`an unrecorded ${archived ? "archived" : "current"} result cannot transfer shared ownership through a later draft`, async () => {
    const f = await fixture();
    try {
      const ref = "artifacts/evidence.txt";
      await receipt(f.root, ref, "Unrelated shared evidence\n");
      await receipt(f.workerRoot, ref, "Local evidence\n");
      await writeFile(
        path.join(f.workerRoot, "result.json"),
        JSON.stringify(
          draft([ref], { provenance: { scanReceiptRefs: [ref] } }),
        ),
      );
      let prefix = f.prefix;
      if (archived) {
        const archive = path.join(
          path.dirname(f.workerRoot),
          "attempts/attempt-01",
        );
        await mkdir(path.dirname(archive), { recursive: true });
        await rename(f.workerRoot, archive);
        await mkdir(f.workerRoot);
        prefix = path.relative(f.root, archive).split(path.sep).join("/");
      }
      await recordCodexSecurityWorkerScanDraft(
        f.worker,
        archived ? workerDraft([]) : draft([ref], { notes: "Updated review." }),
      );
      const sources = await readDeepReductionSources(f.reducer);
      const [surface] = sources.discoveries[0].coverage.surfaces;
      assert.deepEqual(surface.receiptRefs, [`${prefix}/${ref}`]);
      assert.equal(
        await readFile(path.join(f.root, surface.receiptRefs[0]), "utf8"),
        "Local evidence\n",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("newly resolved shared receipts survive a later local collision alongside inherited receipts", async () => {
  const f = await fixture();
  try {
    const refs = ["artifacts/first.txt", "artifacts/second.txt"];
    for (const ref of refs) await receipt(f.root, ref, "Shared evidence\n");
    await recordCodexSecurityWorkerScanDraft(f.worker, draft([refs[0]!]));
    await recordCodexSecurityWorkerScanDraft(f.worker, draft(refs));
    await receipt(f.workerRoot, refs[1]!, "Unrelated local evidence\n");
    const sources = await readDeepReductionSources(f.reducer);
    assert.deepEqual(
      sources.discoveries[0].coverage.surfaces[0].receiptRefs,
      refs,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const complete of [false, true]) {
  for (const archived of [false, true]) {
    for (const lost of [false, true]) {
      test(`first saved local receipt in a ${complete ? "result" : "checkpoint"} stays owned after ${archived ? "archiving" : "acceptance"} (${lost ? "lost" : "present"})`, async () => {
        const f = await fixture();
        try {
          const ref = "artifacts/evidence.txt";
          await receipt(f.workerRoot, ref, "Local evidence\n");
          await receipt(f.root, ref, "Unrelated shared evidence\n");
          await recordCodexSecurityWorkerScanDraft(f.worker, {
            ...draft([ref]),
            complete,
          });
          let output = f.workerRoot;
          if (archived) {
            output = path.join(
              path.dirname(f.workerRoot),
              "attempts/attempt-01",
            );
            await mkdir(path.dirname(output), { recursive: true });
            await rename(f.workerRoot, output);
          }
          if (lost) await rm(path.join(output, ref));
          if (archived) {
            await mkdir(f.workerRoot);
            await recordCodexSecurityWorkerScanDraft(f.worker, workerDraft([]));
          }
          const expected = `${path.relative(f.root, output).split(path.sep).join("/")}/${ref}`;
          if (complete) {
            const sources = await readDeepReductionSources(f.reducer);
            assert.deepEqual(
              sources.discoveries[0].coverage.surfaces[0].receiptRefs,
              [expected],
            );
          }
          const recovered = recoverCoverage(f, complete);
          assert.deepEqual(recovered.refs, [expected]);
          assert.equal(
            recovered.surfaces[0].disposition,
            lost ? "needs_follow_up" : "no_issue_found",
          );
          assert.equal(
            recovered.warnings.some((warning: string) =>
              warning.includes("coverage receipt"),
            ),
            lost,
          );
        } finally {
          await rm(f.root, { recursive: true, force: true });
        }
      });
    }
  }
}

test("a draft preserved after a malformed result keeps its local receipt after loss", async () => {
  const f = await fixture();
  try {
    const ref = "artifacts/evidence.txt";
    await receipt(f.workerRoot, ref, "Local evidence\n");
    await receipt(f.root, ref, "Unrelated shared evidence\n");
    const resultPath = path.join(f.workerRoot, "result.json");
    await writeFile(resultPath, "{broken");
    await assert.rejects(
      recordCodexSecurityWorkerScanDraft(f.worker, draft([ref])),
      /stored JSON is malformed/,
    );
    await rm(resultPath);
    await rm(path.join(f.workerRoot, ref));
    await recordCodexSecurityWorkerScanDraft(f.worker, workerDraft([]));
    const sources = await readDeepReductionSources(f.reducer);
    assert.deepEqual(sources.discoveries[0].coverage.surfaces[0].receiptRefs, [
      `${f.prefix}/${ref}`,
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const spelling of ["original", "returned"] as const) {
  for (const sharedExists of [false, true]) {
    for (const observation of [
      "same",
      "notes",
      "new id",
      "new disposition",
    ] as const) {
      for (const newLocal of [false, true]) {
        test(`resubmitted ${spelling} receipt survives two archives: ${observation}, shared=${sharedExists}, new local=${newLocal}`, async () => {
          const f = await fixture();
          try {
            const ref = "artifacts/evidence.txt";
            await receipt(f.workerRoot, ref, "Original local evidence\n");
            if (sharedExists)
              await receipt(f.root, ref, "Unrelated shared evidence\n");
            const first = await recordCodexSecurityWorkerScanDraft(
              f.worker,
              draft([ref]),
            );
            const submitted =
              spelling === "original"
                ? ref
                : first.coverage.surfaces[0].receiptRefs[0];
            let ownedRef = `${f.prefix}/${ref}`;
            let contents = "Original local evidence\n";
            for (const attempt of [1, 2]) {
              const archive = path.join(
                path.dirname(f.workerRoot),
                "attempts",
                `attempt-0${attempt}`,
              );
              const archivePrefix = path
                .relative(f.root, archive)
                .split(path.sep)
                .join("/");
              const priorResult = await readFile(
                path.join(f.workerRoot, "result.json"),
                "utf8",
              );
              await archiveDirectory(f.workerRoot, archive);
              if (ownedRef.startsWith(`${f.prefix}/`))
                ownedRef = `${archivePrefix}/${ref}`;
              const retained =
                observation === "same" || observation === "notes";
              if (newLocal) {
                contents = `New local evidence ${attempt}\n`;
                await receipt(f.workerRoot, ref, contents);
                ownedRef = `${f.prefix}/${ref}`;
              } else if (!retained) {
                ownedRef =
                  sharedExists && spelling === "original"
                    ? ref
                    : `${f.prefix}/${ref}`;
                contents = "Unrelated shared evidence\n";
              }
              const id =
                observation === "new id"
                  ? `new-route-${attempt}`
                  : "reviewed-route";
              await recordCodexSecurityWorkerScanDraft(
                f.worker,
                draft([submitted], {
                  id,
                  ...(observation === "notes"
                    ? { notes: `Retry notes ${attempt}` }
                    : {}),
                  ...(observation === "new disposition"
                    ? {
                        disposition:
                          attempt === 1 ? "not_applicable" : "rejected",
                      }
                    : {}),
                }),
              );
              const sources = await readDeepReductionSources(f.reducer);
              const projected = sources.discoveries[0].coverage.surfaces.find(
                (surface: { provenance?: { sourceId?: string } }) =>
                  surface.provenance?.sourceId === id,
              );
              assert.ok(projected);
              assert.deepEqual(projected.receiptRefs, [ownedRef]);
              if (
                newLocal ||
                retained ||
                (sharedExists && spelling === "original")
              ) {
                assert.equal(
                  await readFile(path.join(f.root, ownedRef), "utf8"),
                  contents,
                );
              } else {
                await assert.rejects(readFile(path.join(f.root, ownedRef)), {
                  code: "ENOENT",
                });
              }
              assert.equal(
                await readFile(path.join(archive, "result.json"), "utf8"),
                priorResult,
              );
            }
            if (observation === "same" || observation === "notes") {
              const recovered = recoverCoverage(f, true, 3);
              assert.deepEqual(recovered.refs, [ownedRef]);
              assert.equal(recovered.surfaces[0].disposition, "no_issue_found");
              assert.deepEqual(recovered.warnings, []);
            }
          } finally {
            await rm(f.root, { recursive: true, force: true });
          }
        });
      }
    }
  }
}

for (const spelling of ["original", "returned"] as const) {
  test(`resubmitted ${spelling} receipt cannot fall back to shared evidence after archived evidence is lost`, async () => {
    const f = await fixture();
    try {
      const ref = "artifacts/evidence.txt";
      await receipt(f.workerRoot, ref, "Original local evidence\n");
      await receipt(f.root, ref, "Unrelated shared evidence\n");
      const first = await recordCodexSecurityWorkerScanDraft(
        f.worker,
        draft([ref]),
      );
      const archive = path.join(
        path.dirname(f.workerRoot),
        "attempts/attempt-01",
      );
      await archiveDirectory(f.workerRoot, archive);
      await rm(path.join(archive, ref));
      await recordCodexSecurityWorkerScanDraft(
        f.worker,
        draft([
          spelling === "original"
            ? ref
            : first.coverage.surfaces[0].receiptRefs[0],
        ]),
      );
      const expected = `${path.relative(f.root, archive).split(path.sep).join("/")}/${ref}`;
      const sources = await readDeepReductionSources(f.reducer);
      assert.deepEqual(
        sources.discoveries[0].coverage.surfaces[0].receiptRefs,
        [expected],
      );
      const recovered = recoverCoverage(f, true, 2);
      assert.deepEqual(recovered.refs, [expected]);
      assert.equal(recovered.surfaces[0].disposition, "needs_follow_up");
      assert.ok(
        recovered.warnings.some((warning: string) =>
          warning.includes("coverage receipt"),
        ),
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

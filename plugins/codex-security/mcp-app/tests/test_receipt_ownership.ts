import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

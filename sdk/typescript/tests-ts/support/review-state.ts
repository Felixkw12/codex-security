import { join } from "node:path";
import { expect } from "bun:test";
import type { CoverageDocument } from "../../src/models.js";
import { PLUGIN_ROOT } from "../plugin-root.js";
import { runPython } from "./python-probe.js";

export async function readReviewState(
  scanDir: string,
): Promise<CoverageDocument> {
  const python = Bun.which("python3") ?? Bun.which("python")!;
  const script = [
    "import json, pathlib, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from review_state import review_state",
    "scan_dir = pathlib.Path(sys.argv[2])",
    "scan = json.loads((scan_dir / 'scan-manifest.json').read_text())['scan']",
    "if 'coverageRef' in scan:",
    "    print((scan_dir / 'coverage.json').read_text()); sys.exit(0)",
    "if 'reviewState' in scan:",
    "    print(json.dumps(review_state(scan))); sys.exit(0)",
    "head = json.loads((scan_dir / 'checkpoint-head.json').read_text())",
    "checkpoint = json.loads((scan_dir / 'checkpoints' / head['checkpoint']).read_text())",
    "print(json.dumps(review_state({**scan, 'reviewState': checkpoint['reviewState']})))",
  ].join("\n");
  const result = runPython(python, [
    "-c",
    script,
    join(PLUGIN_ROOT, "scripts"),
    scanDir,
  ]);
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

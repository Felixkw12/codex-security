import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readReportFile, type ScanResults } from './results.js';
import type { Inputs } from './inputs.js';
import { runProcess, safeLogLines } from './process.js';

export async function collectReports(result: ScanResults): Promise<Map<string, Buffer>> {
  const reports = new Map<string, Buffer>();
  for (const [name, path] of [
    ['scan-manifest.json', result.paths.manifestPath], ['findings.json', result.paths.jsonPath],
    ['coverage.json', result.paths.coveragePath], ['exports/results.sarif', result.paths.sarifPath],
  ]) {
    if (!path) continue;
    const data = await readReportFile(result.paths.resultsDirectory, name);
    reports.set(name, data);
  }
  return reports;
}
export async function uploadReports(reports: Map<string, Buffer>, inputs: Inputs, tempRoot: string, actionRoot: string, log?: (line: string) => void): Promise<void> {
  if (!reports.size) throw new Error('Artifact upload requested, but no validated reports are available.');
  // The uploader needs the runner's artifact-service credentials and network settings.
  // Snapshot them per upload; the scanner's restricted environment stays separate.
  const env = { ...process.env };
  const staging = await mkdtemp(join(tempRoot, 'codex-security-upload-'));
  try {
    await chmod(staging, 0o700);
    const files: string[] = [];
    for (const [name, bytes] of reports) {
      const dest = join(staging, name === 'exports/results.sarif' ? 'results.sarif' : name);
      await writeFile(dest, bytes, {mode: 0o600, flag: 'wx'});
      files.push(dest);
    }
    const execution = await runProcess(process.execPath, [
      '--unhandled-rejections=strict', join(actionRoot, 'dist', 'artifact-upload.cjs'),
      JSON.stringify({name: inputs.artifactName, files, staging, retentionDays: inputs.retentionDays}),
    ], {cwd: staging, env});
    // The trusted uploader's stdout includes runner commands such as upstream
    // secret masks and debug logs. Preserve them before replaying stderr.
    for (const message of [execution.stdout, ...safeLogLines(execution.stderr)]) {
      if (!message) continue;
      try { log?.(message); }
      catch { /* Optional diagnostics must not prevent report cleanup. */ }
    }
    if (execution.exitCode !== 0 || execution.signal || execution.timedOut || execution.interrupted) {
      throw new Error(`Artifact upload failed (exit ${execution.exitCode}${execution.signal ? `, signal ${execution.signal}` : ''}${execution.timedOut ? ', timed out' : ''}${execution.interrupted ? ', interrupted' : ''}).${execution.stderr ? `\n${execution.stderr.trimEnd()}` : ''}`);
    }
  } finally { await rm(staging, {recursive: true, force: true}); }
}

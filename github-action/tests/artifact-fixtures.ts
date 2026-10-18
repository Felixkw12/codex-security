import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type UploadBehavior = 'success' | 'reject' | 'stream-error' | 'unhandled-rejection' | 'cancel' | 'runner-commands';
export const uploadSignature = 'synthetic-artifact+signature/value';
export const uploadFailure = 'Synthetic artifact upload failure: sk-synthetic/diagnostic+value';
export const uploadEnvironment = {
  ACTIONS_RUNTIME_TOKEN: 'synthetic-artifact-token',
  ACTIONS_RESULTS_URL: 'https://artifacts.example.invalid/',
  HTTP_PROXY: 'http://proxy.example.invalid:8080',
  HTTPS_PROXY: 'http://proxy.example.invalid:8443',
  NO_PROXY: 'example.invalid',
  RUNNER_TRACKING_ID: 'synthetic-runner-tracking-id',
};

// Bundle the production entrypoint with an offline uploader, then execute that
// bundle through the same subprocess boundary used by the Action.
export async function buildUploadWorker(actionRoot: string, behavior: UploadBehavior = 'success', diagnostic = uploadFailure): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/artifact-upload.ts', import.meta.url))],
    outfile: join(actionRoot, 'dist', 'artifact-upload.cjs'),
    platform: 'node', target: 'node24', format: 'cjs', bundle: true,
    plugins: [{name: 'offline-artifact-client', setup(builder) {
      builder.onResolve({filter: /^@actions\/artifact$/}, () => ({path: 'client', namespace: 'offline-artifact-client'}));
      builder.onLoad({filter: /.*/, namespace: 'offline-artifact-client'}, () => ({resolveDir: fileURLToPath(new URL('../', import.meta.url)), contents: `
        import * as core from '@actions/core';
        import { readFile, readdir, stat } from 'node:fs/promises';
        import { basename } from 'node:path';
        import { PassThrough } from 'node:stream';
        export class DefaultArtifactClient {
          async uploadArtifact(name, files, staging, options) {
            const reports = await Promise.all(files.map(async path => ({
              path, name: basename(path), contents: (await readFile(path)).toString('base64'),
              mode: (await stat(path)).mode & 0o777,
            })));
            console.log('UPLOAD_RECEIPT:' + JSON.stringify({
              name, options, reports, staging, stagingMode: (await stat(staging)).mode & 0o777,
              entries: (await readdir(staging)).sort(),
              environment: Object.fromEntries(${JSON.stringify(Object.keys(uploadEnvironment))}.map(key => [key, process.env[key]])),
            }));
            console.log('Synthetic uploader stdout: ' + ${JSON.stringify(diagnostic)});
            console.error('Synthetic uploader stderr: ' + ${JSON.stringify(diagnostic)});
            // Every outcome leaves a handle alive to catch exitCode-only workers.
            setInterval(() => {}, 1000);
            switch (${JSON.stringify(behavior)}) {
              case 'success': return {id: 1, size: 1};
              case 'reject': throw new Error(${JSON.stringify(diagnostic)});
              case 'stream-error':
                setImmediate(() => new PassThrough().destroy(new Error(${JSON.stringify(diagnostic)})));
                break;
              case 'unhandled-rejection':
                void Promise.reject(new Error(${JSON.stringify(diagnostic)}));
                break;
              case 'cancel':
                process.on('SIGTERM', () => process.exit(0));
                process.kill(process.ppid, 'SIGTERM');
                break;
              case 'runner-commands': {
                const signature = ${JSON.stringify(uploadSignature)};
                core.setSecret(signature);
                core.setSecret(encodeURIComponent(signature));
                core.debug('Synthetic artifact response: https://artifacts.example.invalid/upload?sig=' + encodeURIComponent(signature));
                console.error('Synthetic signed error: ' + signature);
                throw new Error('Synthetic signed upload failure: ' + signature);
              }
            }
            await new Promise(() => {});
          }
        }
      `}));
    }}],
  });
}

export function uploadReceipt(logs: string): {
  name: string; options: {retentionDays: number; compressionLevel: number};
  reports: Array<{path: string; name: string; contents: string; mode: number}>;
  staging: string; stagingMode: number; entries: string[]; environment: Record<string, string>;
} {
  const receipt = logs.match(/UPLOAD_RECEIPT:(.*)/)?.[1];
  if (!receipt) throw new Error('Offline uploader did not record its invocation.');
  return JSON.parse(receipt);
}

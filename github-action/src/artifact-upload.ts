import { DefaultArtifactClient } from '@actions/artifact';

async function upload(): Promise<void> {
  const {name, files, staging, retentionDays} = JSON.parse(process.argv[2]) as {
    name: string; files: string[]; staging: string; retentionDays: number;
  };
  await new DefaultArtifactClient().uploadArtifact(name, files, staging, {retentionDays, compressionLevel: 0});
}

function finish(code: number): void {
  // Flush diagnostics before exiting, even if the uploader left active handles.
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

function fail(error: unknown): void {
  console.error(error);
  finish(1);
}

// A fatal stream error must also flush pending toolkit masks and diagnostics.
process.once('uncaughtException', fail);
void upload().then(() => finish(0), fail);

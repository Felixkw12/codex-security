import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadReports } from '../src/artifacts.js';
import { parseInputs } from '../src/inputs.js';
import { buildUploadWorker, uploadEnvironment, uploadFailure, uploadReceipt, uploadSignature } from './artifact-fixtures.js';

const reports = new Map([
  ['scan-manifest.json', Buffer.from('{"scan":"synthetic"}\n')],
  ['findings.json', Buffer.from('{"findings":[]}\n')],
  ['coverage.json', Buffer.from('{"coverage":"synthetic"}\n')],
  ['exports/results.sarif', Buffer.from('{"version":"2.1.0"}\n')],
]);
const inputs = {...parseInputs(() => '', '/synthetic/repo'), artifactName: 'synthetic report bundle', retentionDays: 14};

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-artifact-test-'));
  const previous = {...process.env};
  Object.assign(process.env, uploadEnvironment);
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, {recursive: true, force: true});
  });
  return root;
}

async function assertCleaned(root: string, logs: string): Promise<void> {
  const receipt = uploadReceipt(logs);
  await assert.rejects(stat(receipt.staging), {code: 'ENOENT'});
  assert.ok(!(await readdir(root)).some(name => name.startsWith('codex-security-upload-')));
}

test('upload subprocess preserves options, report bytes, private staging and runner environment', {timeout: 10_000}, async t => {
  const root = await fixture(t);
  await buildUploadWorker(root);
  const logs: string[] = [];
  await uploadReports(reports, inputs, root, root, line => logs.push(line));
  const receipt = uploadReceipt(logs.join('\n'));
  assert.equal(receipt.name, inputs.artifactName);
  assert.deepEqual(receipt.options, {retentionDays: 14, compressionLevel: 0});
  assert.deepEqual(receipt.environment, uploadEnvironment);
  assert.equal(receipt.stagingMode, 0o700);
  assert.deepEqual(receipt.entries, ['coverage.json', 'findings.json', 'results.sarif', 'scan-manifest.json']);
  for (const file of receipt.reports) {
    const name = file.name === 'results.sarif' ? 'exports/results.sarif' : file.name;
    assert.deepEqual(Buffer.from(file.contents, 'base64'), reports.get(name));
    assert.equal(file.mode, 0o600);
    assert.equal(file.path, join(receipt.staging, file.name));
  }
  assert.ok(logs.join('\n').includes(`Synthetic uploader stdout: ${uploadFailure}`));
  assert.ok(logs.includes(`[codex-security] Synthetic uploader stderr: ${uploadFailure}`));
  await assertCleaned(root, logs.join('\n'));
});

for (const behavior of ['reject', 'stream-error', 'unhandled-rejection'] as const) {
  test(`${behavior} exits the upload worker and removes private staging`, {timeout: 10_000}, async t => {
    const root = await fixture(t);
    await buildUploadWorker(root, behavior);
    // The worker must fail even when the inherited Node setting only warns.
    process.env.NODE_OPTIONS = '--unhandled-rejections=warn';
    const logs: string[] = [];
    await assert.rejects(uploadReports(reports, inputs, root, root, line => logs.push(line)), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Artifact upload failed \(exit 1\)/);
      assert.ok(error.message.includes(uploadFailure));
      return true;
    });
    assert.ok(logs.join('\n').includes(`Synthetic uploader stdout: ${uploadFailure}`));
    assert.ok(logs.includes(`[codex-security] Synthetic uploader stderr: ${uploadFailure}`));
    await assertCleaned(root, logs.join('\n'));
  });
}

test('concurrent uploads snapshot their own inherited environment before staging', {timeout: 10_000}, async t => {
  const root = await fixture(t);
  await buildUploadWorker(root);
  const firstLogs: string[] = [];
  const first = uploadReports(reports, inputs, root, root, line => firstLogs.push(line));
  process.env.ACTIONS_RUNTIME_TOKEN = 'synthetic-second-token';
  process.env.HTTPS_PROXY = 'http://second-proxy.example.invalid:8443';
  const secondLogs: string[] = [];
  const second = uploadReports(reports, inputs, root, root, line => secondLogs.push(line));
  process.env.ACTIONS_RUNTIME_TOKEN = 'synthetic-later-token';
  await Promise.all([first, second]);
  const firstReceipt = uploadReceipt(firstLogs.join('\n'));
  const secondReceipt = uploadReceipt(secondLogs.join('\n'));
  assert.deepEqual(firstReceipt.environment, uploadEnvironment);
  assert.deepEqual(secondReceipt.environment, {...uploadEnvironment,
    ACTIONS_RUNTIME_TOKEN: 'synthetic-second-token', HTTPS_PROXY: 'http://second-proxy.example.invalid:8443'});
  assert.notEqual(firstReceipt.staging, secondReceipt.staging);
  assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, 'synthetic-later-token');
  await assertCleaned(root, firstLogs.join('\n'));
  await assertCleaned(root, secondLogs.join('\n'));
});

test('relative NODE_OPTIONS preload resolves from the snapshotted caller directory', {timeout: 10_000}, async t => {
  const root = await fixture(t);
  await buildUploadWorker(root);
  await writeFile(join(root, 'startup.cjs'), 'process.env.RUNNER_TRACKING_ID = "synthetic-preloaded-runner";\n');
  const previousCwd = process.cwd();
  const logs: string[] = [];
  process.env.NODE_OPTIONS = '--require=./startup.cjs';
  let upload: Promise<void>;
  try {
    process.chdir(root);
    upload = uploadReports(reports, inputs, root, root, line => logs.push(line));
  } finally { process.chdir(previousCwd); }
  process.env.NODE_OPTIONS = '--require=./missing-after-start.cjs';
  await upload;
  assert.equal(uploadReceipt(logs.join('\n')).environment.RUNNER_TRACKING_ID, 'synthetic-preloaded-runner');
  assert.equal(process.env.RUNNER_TRACKING_ID, uploadEnvironment.RUNNER_TRACKING_ID);
  await assertCleaned(root, logs.join('\n'));
});

test('relative NODE_EXTRA_CA_CERTS loads trust from the snapshotted caller directory', {timeout: 10_000}, async t => {
  const root = await fixture(t);
  await buildUploadWorker(root, 'extra-ca');
  const certificate = await readFile(new URL('./fixtures/upload-ca.pem', import.meta.url), 'utf8');
  await mkdir(join(root, 'certificates'));
  await writeFile(join(root, 'certificates', 'upload-ca.pem'), certificate);
  const previousCwd = process.cwd();
  const logs: string[] = [];
  process.env.NODE_EXTRA_CA_CERTS = './certificates/upload-ca.pem';
  let upload: Promise<void>;
  try {
    process.chdir(root);
    upload = uploadReports(reports, inputs, root, root, line => logs.push(line));
  } finally { process.chdir(previousCwd); }
  process.env.NODE_EXTRA_CA_CERTS = './missing-after-start.pem';
  await upload;
  const output = logs.join('\n');
  const certificates = JSON.parse(output.match(/UPLOAD_CA_CERTIFICATES:(.*)/)?.[1] ?? 'null') as string[];
  assert.equal(certificates.length, 1);
  assert.equal(certificates[0].trim(), certificate.trim());
  assert.doesNotMatch(output, /Ignoring extra certs/);
  await assertCleaned(root, output);
});

for (const behavior of ['success', 'reject', 'stream-error', 'unhandled-rejection'] as const) {
  test(`${behavior} flushes diagnostics before exiting with a live uploader handle`, {timeout: 10_000}, async t => {
    const root = await fixture(t);
    const diagnostic = `::warning::${'synthetic-detail '.repeat(10_000)}sk-synthetic/diagnostic+value`;
    await buildUploadWorker(root, behavior, diagnostic);
    const logs: string[] = [];
    const upload = uploadReports(reports, inputs, root, root, line => logs.push(line));
    if (behavior === 'success') await upload;
    else await assert.rejects(upload, error => error instanceof Error && error.message.includes(diagnostic));
    assert.ok(logs.join('\n').includes(`Synthetic uploader stdout: ${diagnostic}`));
    assert.ok(logs.includes(`[codex-security] Synthetic uploader stderr: ${diagnostic}`));
    await assertCleaned(root, logs.join('\n'));
  });
}

test('cancellation fails reporting even when the upload worker exits zero', {timeout: 10_000}, async t => {
  const root = await fixture(t);
  await buildUploadWorker(root, 'cancel');
  const logs: string[] = [];
  await assert.rejects(uploadReports(reports, inputs, root, root, line => logs.push(line)), /Artifact upload failed \(exit 0, interrupted\)/);
  await assertCleaned(root, logs.join('\n'));
});

test('upstream mask and debug commands retain runner semantics before failure diagnostics', {timeout: 10_000}, async t => {
  const root = await fixture(t);
  await buildUploadWorker(root, 'runner-commands');
  const logs: string[] = [];
  await assert.rejects(uploadReports(reports, inputs, root, root, line => logs.push(line)), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(`Synthetic signed upload failure: ${uploadSignature}`));
    return true;
  });
  const output = logs.join('\n');
  const mask = `::add-mask::${uploadSignature}`;
  const encodedMask = '::add-mask::synthetic-artifact%252Bsignature%252Fvalue';
  const debug = '::debug::Synthetic artifact response: https://artifacts.example.invalid/upload?sig=synthetic-artifact%252Bsignature%252Fvalue';
  assert.ok(output.includes(`\n${mask}\n${encodedMask}\n${debug}\n`));
  assert.doesNotMatch(output, /^\[codex-security\] ::(?:add-mask|debug)::/m);
  assert.ok(output.indexOf(mask) < output.indexOf('[codex-security] Synthetic signed error:'));
  assert.ok(output.indexOf(encodedMask) < output.indexOf('[codex-security] Error: Synthetic signed upload failure:'));
  await assertCleaned(root, output);
});

for (const behavior of ['success', 'reject'] as const) {
  test(`optional upload diagnostics cannot change ${behavior} or prevent staging cleanup`, {timeout: 10_000}, async t => {
    const root = await fixture(t);
    await buildUploadWorker(root, behavior);
    const upload = uploadReports(reports, inputs, root, root, () => { throw new Error('Synthetic log failure'); });
    if (behavior === 'success') await upload;
    else await assert.rejects(upload, error => error instanceof Error && error.message.includes(uploadFailure));
    assert.ok(!(await readdir(root)).some(name => name.startsWith('codex-security-upload-')));
  });
}

test('worker startup failure still removes the staged reports', async t => {
  const root = await fixture(t);
  await assert.rejects(uploadReports(reports, inputs, root, root), /Cannot find module/);
  assert.deepEqual(await readdir(root), []);
});

test('upload without validated reports fails before staging or starting a worker', async t => {
  const root = await fixture(t);
  await assert.rejects(uploadReports(new Map(), inputs, root, root), /no validated reports/);
  assert.deepEqual(await readdir(root), []);
});

test('enterprise artifacts use the runner results service through the real client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'action-artifact-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const previous = {...process.env};
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const requests: {url?: string; authorization?: string; body: any}[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({url:request.url, authorization:request.headers.authorization, body:JSON.parse(body)});
    // Stop after artifact creation so this test needs no external blob service.
    response.writeHead(200, {'Content-Type':'application/json'});
    response.end(JSON.stringify({ok:false}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const payload = Buffer.from(JSON.stringify({scp:'Actions.Results:synthetic-run:synthetic-job'})).toString('base64url');
  const token = `e30.${payload}.synthetic-signature`;
  Object.assign(process.env, {
    GITHUB_SERVER_URL:'https://example-enterprise.ghe.com',
    ACTIONS_RESULTS_URL:`http://127.0.0.1:${address.port}`,
    ACTIONS_RUNTIME_TOKEN:token,
  });
  await assert.rejects(uploadReports(new Map([['findings.json', Buffer.from('{}')]]), parseInputs(() => '', root), root, fileURLToPath(new URL('../', import.meta.url))),
    /CreateArtifact: response from backend was not ok/);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url ?? '', /\/twirp\/.*\.ArtifactService\/CreateArtifact$/);
  assert.equal(requests[0].authorization, `Bearer ${token}`);
  assert.equal(requests[0].body.workflow_run_backend_id, 'synthetic-run');
  assert.equal(requests[0].body.workflow_job_run_backend_id, 'synthetic-job');
  assert.equal(requests[0].body.name, 'codex-security');
  assert.deepEqual(await readdir(root), []);
});

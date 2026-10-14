import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CodexSecurity,
  ScanCostLimitExceededError,
  type ScanCost,
  type ScanTokenUsage,
} from "../../sdk/typescript/dist/index.js"
import { resolveCodexCommand } from "../../sdk/typescript/dist/runtime.js"
import { createFixture } from "../secret-discovery/fixtures.mts"
import { measure, outcome } from "./metrics.mts"
import { stageFixture } from "./replay.mts"

const checkout = resolve(import.meta.dirname, "../..")
const git = (...args: string[]) =>
  execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim()
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"))
const save = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n")
const fixture = process.argv[2]
  ? ((await json(resolve(process.argv[2]))) as ReturnType<typeof createFixture>)
  : createFixture()
const reports = join(checkout, "reports/scan-comparison")
await mkdir(reports, { recursive: true })
const reportDir = await mkdtemp(join(reports, "run-"))
const root = await realpath(await mkdtemp(join(tmpdir(), "scan-comparison-")))
const codexPath = resolveCodexCommand({}).command
// Use the lockfile's CLI even if the caller selected another executable.
process.env.CODEX_CLI_PATH = codexPath
const config = {
  model: "gpt-5.6-sol",
  model_provider: "openai",
  model_reasoning_effort: "xhigh",
  web_search: "disabled",
  approval_policy: "never",
  features: {
    multi_agent_v2: { enabled: true, max_concurrent_threads_per_session: 2 },
  },
}
const bounds = { maxCostUsd: 3, timeoutMs: 600_000 }
const deep = {
  workers: 1,
  subagents: 0,
  maxDiscoveryRuns: 2,
  maxTimeHours: 1 / 12,
  stopAfterNoNew: 2,
  stopAfterConsecutiveErrors: 2,
}
const provenance = {
  sourceCommit: git("rev-parse", "HEAD"),
  pluginTree: git("rev-parse", "HEAD:plugins/codex-security"),
  packageVersion: (await json(join(checkout, "sdk/typescript/package.json")))
    .version,
  pluginVersion: (
    await json(
      join(checkout, "plugins/codex-security/.codex-plugin/plugin.json"),
    )
  ).version,
  codexVersion: execFileSync(codexPath, ["--version"], {
    encoding: "utf8",
  }).trim(),
  fixtureSha256: createHash("sha256")
    .update(JSON.stringify(fixture.files))
    .digest("hex"),
  sourceHashes: Object.fromEntries(
    await Promise.all(
      [
        "evals/scan-comparison/run.mts",
        "evals/scan-comparison/metrics.mts",
        "evals/scan-comparison/replay.mts",
        "evals/secret-discovery/fixtures.mts",
        "evals/secret-discovery/grade.mts",
        "sdk/typescript/pnpm-lock.yaml",
      ].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(checkout, path)))
          .digest("hex"),
      ]),
    ),
  ),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  config,
  bounds,
  scanPrompt:
    "Inspect only this repository and the scanner runtime. Do not use network access or inspect other repositories or evaluation files.",
}
await save(join(reportDir, "configuration.json"), provenance)
console.log(`Comparison artifacts: ${reportDir}`)
const interrupt = new AbortController()
const stop = () => interrupt.abort(new Error("Evaluation interrupted"))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
try {
  for (const mode of ["standard", "deep"] as const) {
    if (interrupt.signal.aborted) break
    const repo = join(root, mode)
    await stageFixture(repo, fixture)
    const outputDir = join(reportDir, mode)
    const security = new CodexSecurity({ codexOverrides: config })
    const timeout = AbortSignal.timeout(bounds.timeoutMs)
    const signal = AbortSignal.any([interrupt.signal, timeout])
    const startedAt = new Date().toISOString()
    const started = performance.now()
    let cost: Readonly<ScanCost> | null = null
    let usage: Readonly<ScanTokenUsage> | null = null
    let grade: ReturnType<typeof measure> | null = null
    let status: Parameters<typeof outcome>[0] = "failed"
    let error: string | null = null
    const warnings: string[] = []
    const sessions = new Map<string, unknown>()
    const options = {
      mode,
      auth: "api-key" as const,
      cyberAccessProgram: "standard" as const,
      outputDir,
      maxCostUsd: bounds.maxCostUsd,
      scanPrompt: provenance.scanPrompt,
      ...(mode === "deep" ? deep : {}),
    }
    console.log(`Starting ${mode}`)
    try {
      const result = await security.run(repo, {
        ...options,
        signal,
        onCost(value) {
          cost = value
        },
        onUsage(value) {
          usage = value
        },
        onWarning(value) {
          warnings.push(value)
        },
        onSessionEvent({ threadId, event }) {
          if (event.type === "session_meta" || event.type === "turn_context") {
            sessions.set(`${threadId}:${event.type}`, event)
          }
        },
      })
      cost = result.cost ?? cost
      grade = measure(
        { findings: result.findings.findings, coverage: result.coverage },
        fixture,
        repo,
      )
      status = "completed"
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
      status = interrupt.signal.aborted
        ? "interrupted"
        : timeout.aborted
          ? "timeout"
          : caught instanceof ScanCostLimitExceededError
            ? "cost_limit"
            : "failed"
    } finally {
      const report = {
        ...outcome(status, grade, fixture.positives.length),
        mode,
        options,
        startedAt,
        elapsedSeconds: (performance.now() - started) / 1000,
        error,
        warnings,
        cost,
        usage,
        costAccounting:
          status === "completed"
            ? "SDK final estimate"
            : "last observed estimate, may omit in-flight usage",
        billedUsd: null,
      }
      try {
        await save(join(reportDir, `${mode}.json`), report)
        await save(join(reportDir, `${mode}-sessions.json`), [
          ...sessions.values(),
        ])
      } finally {
        await security.close()
      }
      console.log(JSON.stringify(report, null, 2))
      if (status !== "completed") process.exitCode = 1
    }
  }
} finally {
  // Save replay inputs only after model work has stopped.
  await save(join(reportDir, "fixture.json"), fixture)
  await rm(root, { recursive: true, force: true })
  process.off("SIGINT", stop)
  process.off("SIGTERM", stop)
}

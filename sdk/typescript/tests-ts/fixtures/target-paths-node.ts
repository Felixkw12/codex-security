import assert from "node:assert/strict";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { TestClient } from "../support/api-client.js";
import { main } from "../../src/cli.js";
import { dependencies, fakeResult } from "../cli-fixtures.js";
import { createCliTest } from "../support/cli-run.js";

const root = process.argv[2]!;
const entry = join(root, "entry");
const repository = join(root, "physical", "repository");
const sibling = join(entry, "repository");
await mkdir(join(sibling, "scope"), { recursive: true, mode: 0o700 });
await writeFile(join(sibling, "app.ts"), "export const sibling = true;\n");
await mkdir(join(root, "physical", "child"), { recursive: true, mode: 0o700 });
await mkdir(join(repository, "components", "child"), {
  recursive: true,
  mode: 0o700,
});
await writeFile(join(repository, "components", "app.ts"), "export {};\n");
await writeFile(join(repository, "app.ts"), "export const sibling = true;\n");
await symlink(join(root, "physical", "child"), join(entry, "link"));
await symlink(
  join(repository, "components", "child"),
  join(repository, "scope"),
);
const requestedRepository = `${entry}/link/../repository`;
const localClient = () =>
  new TestClient(
    {},
    {
      environment: {},
      prepareRuntime: async () => {
        throw new Error("Runtime must not initialize");
      },
    },
  );
const client = localClient();
try {
  for (const mode of ["standard", "deep"] as const) {
    for (const requested of [
      requestedRepository,
      relative(process.cwd(), entry) + "/link/../repository",
      "~/entry/link/../repository",
      "~//entry/link/../repository",
    ]) {
      const result = await client.preflight(requested, {
        target: ["scope/../app.ts"],
        mode,
        outputDir: join(root, `output-${mode}`),
      });
      assert.equal(result.repository, await realpath(repository));
      assert.deepEqual(result.target, {
        kind: "paths",
        paths: ["components/app.ts"],
      });
    }
    await rm(sibling, { recursive: true, force: true });
    await rm(join(repository, "app.ts"), { force: true });
  }
  for (const command of ["scan", "policy"]) {
    const { runCli, stdout, stderr } = createCliTest(main);
    assert.equal(
      await runCli([command, requestedRepository, "--dry-run", "--json"], {
        ...dependencies({ currentDirectory: root }),
        createSecurity: localClient,
        createPolicySecurity: localClient,
      }),
      0,
      stderr.text(),
    );
    assert.equal(
      JSON.parse(stdout.text()).repository,
      await realpath(repository),
    );
  }
  for (const home of [undefined, ""]) {
    if (home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = home;
    try {
      for (const requested of [
        "~/entry/link/../repository",
        "~\\entry\\link\\..\\repository",
        "~\\\\entry\\link\\..\\repository",
      ]) {
        const fallback = createCliTest(main);
        assert.equal(
          await fallback.runCli(["policy", requested, "--dry-run", "--json"], {
            ...dependencies({ currentDirectory: root }),
            createPolicySecurity: localClient,
          }),
          0,
          fallback.stderr.text(),
        );
        assert.equal(
          JSON.parse(fallback.stdout.text()).repository,
          await realpath(repository),
        );
      }
    } finally {
      process.env["HOME"] = root;
    }
  }
  const planned = createCliTest(main);
  assert.equal(
    await planned.runCli(
      [
        "scan-components",
        requestedRepository,
        "--component",
        "components",
        "--plan-only",
        "--output-dir",
        join(root, "component-plan"),
        "--json",
      ],
      dependencies({ currentDirectory: root }),
    ),
    0,
    planned.stderr.text(),
  );
  const backslashRepository = join(root, "physical\\repository");
  await mkdir(backslashRepository, { mode: 0o700 });
  assert.equal(
    (await client.preflight("~\\physical\\repository")).repository,
    await realpath(backslashRepository),
  );
  for (const [requested, expected] of [
    [requestedRepository, repository],
    ["~\\physical\\repository", backslashRepository],
  ] as const) {
    let editorOpened = false;
    const interactive = createCliTest(main, { stderr: true });
    assert.equal(
      await interactive.runCli(["scan", requested], {
        ...dependencies({
          currentDirectory: root,
          result: fakeResult(["high"]),
        }),
        confirmPatchReview: async () => true,
        patchEditor: async (selected) => {
          assert.equal(selected, await realpath(expected));
          editorOpened = true;
          return null;
        },
      }),
      0,
      interactive.stderr.text(),
    );
    assert.equal(editorOpened, true);
  }
  await assert.rejects(
    client.preflight(requestedRepository, {
      outputDir: join(repository, "output"),
    }),
    { name: "OutputInsideProtectedRootError" },
  );
  await mkdir(join(entry, "missing"), { mode: 0o700 });
  await assert.rejects(
    client.preflight(`${entry}/link/../missing`),
    /Repository is not a directory/,
  );
  await mkdir(join(root, "outside", "child"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "outside", "app.ts"), "export {};\n");
  await writeFile(join(repository, "app.ts"), "export {};\n");
  await symlink(join(root, "outside", "child"), join(repository, "outside"));
  await assert.rejects(
    client.preflight(repository, { target: ["outside/../app.ts"] }),
    /outside the repository/,
  );
} finally {
  await client.close();
}

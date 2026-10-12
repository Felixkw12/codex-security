import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../src/cli.ts", import.meta.url),
  "utf8",
);
const declaration = source.match(
  /const PATCH_GIT_ENVIRONMENT_RUNNER = (`[\s\S]*?`);/u,
);
expect(declaration).not.toBeNull();
const runner = new Function(`return ${declaration![1]};`)() as string;

const nativeGrants = ["C:/synthetic/repository", "C:/synthetic/repository/*"];
const cases = [
  { name: "wildcard reset", caller: ["*", ""], active: [] },
  {
    name: "named reset with a later grant",
    caller: ["C:/cleared", "", "C:/retained"],
    active: ["C:/retained"],
  },
  {
    name: "repeated resets",
    caller: ["*", "", "C:/cleared", "", "C:/retained"],
    active: ["C:/retained"],
  },
  {
    name: "case-insensitive reset key",
    caller: ["*", ""],
    active: [],
    resetKey: "SAFE.Directory",
  },
  {
    name: "caller grant without a reset",
    caller: ["C:/retained"],
    active: ["C:/retained"],
  },
];

for (const platform of ["win32", "linux"] as const) {
  for (const { name, caller, active, resetKey } of cases) {
    test(`constructs snapshot Git arguments with ${name} on ${platform}`, () => {
      const entries = caller.map((value) => [
        value === "" ? (resetKey ?? "safe.directory") : "safe.directory",
        value,
      ]);
      entries.push(["filter.synthetic.clean", "synthetic-clean-filter"]);
      const environment = (values: string[][]) => ({
        GIT_CONFIG_COUNT: String(values.length),
        ...Object.fromEntries(
          values.flatMap(([key, value], index) => [
            [`GIT_CONFIG_KEY_${index}`, key],
            [`GIT_CONFIG_VALUE_${index}`, value],
          ]),
        ),
      });
      const original = environment(entries);
      const filtered = environment([
        ...entries,
        ...nativeGrants.map((value) => ["safe.directory", value]),
      ]);
      let receive: (chunk: Buffer) => void = () => {
        throw new Error("Snapshot input handler was not installed.");
      };
      const sent: Buffer[] = [];
      const invocations: {
        command: string;
        args: string[];
        environment: object;
      }[] = [];
      const child = {
        on() {},
        stdin: {
          on() {},
          write(chunk: Buffer) {
            sent.push(chunk);
          },
        },
      };
      const process = {
        platform,
        argv: ["node", "git", "-C", "C:/synthetic/repository", "status"],
        env: filtered,
        stdin: {
          on(event: string, listener: typeof receive) {
            expect(event).toBe("data");
            receive = listener;
          },
          off() {},
          pipe(target: unknown) {
            expect(target).toBe(child.stdin);
          },
        },
      };
      // Exercise the exact argument construction without starting a child.
      new Function("require", "process", "Buffer", runner)(
        (module: string) => {
          expect(module).toBe("node:child_process");
          return {
            spawn(command: string, args: string[]) {
              invocations.push({
                command,
                args,
                environment: { ...process.env },
              });
              return child;
            },
          };
        },
        process,
        Buffer,
      );
      const input = Buffer.from([0, 255, 10, 13]);
      receive(
        Buffer.concat([
          Buffer.from(JSON.stringify(Object.entries(original)) + "\n"),
          input,
        ]),
      );
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.command).toBe("git");
      expect(invocations[0]!.args).toEqual([
        ...(platform === "win32"
          ? [...active, ...nativeGrants].flatMap((value) => [
              "-c",
              `safe.directory=${value}`,
            ])
          : []),
        "-C",
        "C:/synthetic/repository",
        "status",
      ]);
      expect(invocations[0]!.environment).toMatchObject(original);
      expect(Buffer.concat(sent)).toEqual(input);
    });
  }
}

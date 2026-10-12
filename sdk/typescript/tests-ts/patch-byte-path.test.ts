import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { relativePatchPath } from "../src/patch-byte-path.js";

const key = (path: string) => Buffer.from(path).toString("latin1");

test("Node Windows comparisons preserve Unicode aliases and dirty overlap", () => {
  const cases = [
    ["C:\\work\\RÉPO", "C:\\work\\répo\\src\\file.ts"],
    ["C:\\work\\répo\\src\\FÍLE.ts", "C:\\work\\répo\\src\\fíle.ts"],
    ["\\\\server\\RÉPO", "\\\\SERVER\\répo\\src\\file.ts"],
    ["C:\\work\\RÉPO", "C:\\work\\other\\src\\file.ts"],
    ["\ufeffFÍLE.ts", "fíle.ts"],
  ];
  const output = execFileSync(
    "node",
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { relativePatchPath } from ${JSON.stringify(new URL("../src/patch-byte-path.ts", import.meta.url).href)};
const key = value => Buffer.from(value).toString("latin1");
const cases = ${JSON.stringify(cases)};
for (const [from, to] of cases) assert.equal(relativePatchPath(key(from), key(to), "win32"), key(win32.relative(from, to)));
const dirty = relativePatchPath(key(cases[0][0]), key(cases[1][0]), "win32");
assert.equal(relativePatchPath(key("src"), dirty, "win32"), key("FÍLE.ts"));
assert.equal(relativePatchPath(key("src/" + "fíle.ts"), dirty, "win32"), "");
console.log(JSON.stringify({ windowsCases: cases.length, dirtyOverlap: true }));
`,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual({ windowsCases: 5, dirtyOverlap: true });
});

test.each(["linux", "darwin"] as const)(
  "%s retains distinct raw-byte names",
  (platform) => {
    const raw = Buffer.concat([
      Buffer.from("/repo/name-"),
      Buffer.from([0xff]),
    ]).toString("latin1");
    const unicode = key("/repo/name-\ufffd");
    expect(relativePatchPath(key("/repo"), raw, platform)).toBe(
      Buffer.concat([Buffer.from("name-"), Buffer.from([0xff])]).toString(
        "latin1",
      ),
    );
    expect(relativePatchPath(raw, unicode, platform)).not.toBe("");
    expect(
      relativePatchPath(key("/repo/RÉPO"), key("/repo/répo"), platform),
    ).toBe(key("../répo"));
  },
);

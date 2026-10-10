import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Git hook entrypoints: https://git-scm.com/docs/githooks
const GIT_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
];

type RunGit = (
  root: string,
  directory: string,
  args: string[],
  encoding?: "base64",
) => Promise<string>;

export interface PatchGitControls {
  readonly readOnlyPaths: readonly string[];
  validate(): Promise<void>;
}

const missing = (error: unknown): undefined => {
  if (
    ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
  )
    return undefined;
  throw error;
};

function inside(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function controlPathText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    throw new Error(
      "Patch cannot safely use Git configuration or administration paths that are not valid UTF-8.",
      { cause },
    );
  }
}

const realControlPath = async (path: string) =>
  controlPathText(await realpath(path, { encoding: "buffer" }));

// Append before realpath so a link/.. path keeps the filesystem's meaning.
const relativeFile = (directory: string, path: string) =>
  isAbsolute(path) ? path : `${directory}${sep}${path}`;

async function readGitMarker(
  marker: string | Buffer,
): Promise<Buffer | true | undefined> {
  const metadata = await stat(marker).catch(missing);
  if (metadata === undefined) return undefined;
  if (metadata.isDirectory()) return true;
  if (!metadata.isFile()) return undefined;
  const contents = await readFile(marker);
  return contents.subarray(0, 8).equals(Buffer.from("gitdir: "))
    ? contents
    : undefined;
}

async function markerDirectories(
  directory: string,
  isGitDirectory: (path: string) => Promise<boolean>,
): Promise<string[] | undefined> {
  const marker = join(directory, ".git");
  const contents = await readGitMarker(marker);
  if (contents === undefined) return undefined;
  const gitDirectory = await (
    contents === true
      ? realControlPath(marker)
      : realControlPath(
          relativeFile(
            directory,
            controlPathText(contents)
              .slice(8)
              .replace(/[\r\n]+$/u, ""),
          ),
        )
  ).catch(missing);
  if (gitDirectory === undefined) return undefined;
  if (
    !(await stat(gitDirectory)).isDirectory() ||
    !(await isGitDirectory(gitDirectory))
  )
    return undefined;
  const commonBytes = await readFile(join(gitDirectory, "commondir")).catch(
    missing,
  );
  const common =
    commonBytes === undefined ? undefined : controlPathText(commonBytes);
  return common === undefined
    ? [gitDirectory]
    : [
        gitDirectory,
        await realControlPath(
          relativeFile(gitDirectory, common.replace(/[\r\n]+$/u, "")),
        ),
      ];
}

// Git permits include files and hook directories that do not exist yet.
async function canonicalPath(path: string): Promise<string> {
  const canonical = await realControlPath(path).catch(missing);
  if (canonical !== undefined) return canonical;
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await canonicalPath(parent), path.slice(parent.length));
}

async function readableGitParent(
  checkout: string,
  path: Buffer,
  directory: boolean,
  gitlink: boolean,
): Promise<{ path: string; exact: boolean } | undefined> {
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  if (path.at(-1) === 47) path = path.subarray(0, -1);
  if (!directory) path = path.subarray(0, Math.max(0, path.lastIndexOf(47)));
  let exact = true;
  while (path.length > 0) {
    try {
      return { path: utf8.decode(path), exact };
    } catch {
      // Check the actual byte path; never inspect its replacement-decoded alias.
    }
    // Ordinary symlink replacements are data, including raw-byte ancestors.
    let skippedSymlink = false;
    for (let offset = 0; offset < path.length;) {
      const separator = path.indexOf(47, offset);
      const end = separator < 0 ? path.length : separator;
      const prefix = path.subarray(0, end);
      if (
        (!gitlink || !exact || end !== path.length) &&
        (
          await lstat(
            Buffer.concat([Buffer.from(`${checkout}${sep}`), prefix]),
          ).catch(missing)
        )?.isSymbolicLink()
      ) {
        path = prefix.subarray(0, Math.max(0, prefix.lastIndexOf(47)));
        exact = false;
        skippedSymlink = true;
        break;
      }
      offset = end + 1;
    }
    if (skippedSymlink) continue;
    const marker = Buffer.concat([
      Buffer.from(`${checkout}${sep}`),
      path,
      Buffer.from(`${sep}.git`),
    ]);
    if ((await readGitMarker(marker)) !== undefined)
      throw new Error(
        "Patch cannot safely use Git administration whose checkout path is not valid UTF-8.",
      );
    path = path.subarray(0, Math.max(0, path.lastIndexOf(47)));
    exact = false;
  }
  return undefined;
}

export async function capturePatchGitControls(
  directory: string,
  run: RunGit,
  usesWorktreeMarker: boolean,
): Promise<PatchGitControls | undefined> {
  const runBytes = async (root: string, checkout: string, args: string[]) =>
    Buffer.from(await run(root, checkout, args, "base64"), "base64");
  const runControl = async (root: string, checkout: string, args: string[]) =>
    controlPathText(await runBytes(root, checkout, args));
  // Config records contain unrelated keys too. Split bytes before decoding paths.
  const runConfigFields = async (checkout: string, args: string[]) =>
    (await runBytes(root, checkout, args)).toString("latin1").split("\0");
  const configPath = (field: string) =>
    controlPathText(Buffer.from(field, "latin1"));
  let root: string;
  try {
    const output = await runControl(directory, directory, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (output.length === 0) return undefined;
    root = await realControlPath(output.replace(/\n$/u, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("not a git repository") ||
      message.toLowerCase() === "git is not available on a trusted path."
    )
      return undefined;
    throw error;
  }
  const isGitDirectory = async (path: string): Promise<boolean> => {
    try {
      // This early rev-parse mode only checks filesystem structure. It does not
      // select the candidate repository or load its configuration and hooks.
      await runControl(root, root, ["rev-parse", "--resolve-git-dir", path]);
      return true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const failure = error as Error & {
        code?: unknown;
        status?: unknown;
        stderr?: unknown;
      };
      const diagnostic = Buffer.isBuffer(failure.stderr)
        ? failure.stderr.toString("utf8")
        : failure.stderr;
      const negative = `fatal: not a gitdir '${path}'`;
      if (
        (failure.code === 128 || failure.status === 128) &&
        typeof diagnostic === "string" &&
        (diagnostic.endsWith(`${negative}\n`) ||
          diagnostic.endsWith(`${negative}\r\n`))
      )
        return false;
      throw error;
    }
  };
  const administrationRoots = new Map<string, { dev: bigint; ino: bigint }>();
  const remember = async (path: string): Promise<void> => {
    const metadata = await stat(path, { bigint: true });
    administrationRoots.set(path, { dev: metadata.dev, ino: metadata.ino });
  };
  const controlPaths = new Map<
    string,
    { canonical: string; identity: { dev: bigint; ino: bigint } | undefined }
  >();
  const inaccessibleIncludes = new Set<string>();
  const rememberControl = async (path: string): Promise<void> => {
    const canonical = await canonicalPath(path);
    const metadata = await stat(canonical, { bigint: true }).catch(missing);
    controlPaths.set(path, {
      canonical,
      identity: metadata && { dev: metadata.dev, ino: metadata.ino },
    });
  };
  const captureReferences = async (checkout: string): Promise<void> => {
    const origins = await runConfigFields(checkout, [
      "config",
      "--null",
      "--show-origin",
      "--includes",
      "--list",
      "--name-only",
    ]);
    let includes = false;
    for (let index = 0; index + 1 < origins.length; index += 2) {
      const origin = origins[index]!;
      if (origin.startsWith("file:"))
        await rememberControl(
          relativeFile(checkout, configPath(origin.slice(5))),
        );
      if (/^(include|includeif\..*)\.path$/u.test(origins[index + 1]!))
        includes = true;
    }
    if (includes) {
      const paths = await runConfigFields(checkout, [
        "config",
        "--null",
        "--show-origin",
        "--includes",
        "--get-regexp",
        "^(include|includeif\\..*)\\.path$",
      ]);
      for (let index = 0; index + 1 < paths.length; index += 2) {
        const origin = paths[index]!;
        const value = paths[index + 1]!;
        const separator = value.indexOf("\n");
        const key = value.slice(0, separator);
        let path = configPath(value.slice(separator + 1));
        if (path.length === 0) continue;
        try {
          // Expand each value with Git without expanding inactive values as a group.
          path = (
            await runControl(root, checkout, [
              "-c",
              `codexsecurity.patchcontrolpath=${path}`,
              "config",
              "--null",
              "--type=path",
              "--get",
              "codexsecurity.patchcontrolpath",
            ])
          ).replace(/\0$/u, "");
        } catch (error) {
          // Active includes already passed Git's normal --includes read above.
          if (
            key.startsWith("includeif.") &&
            error instanceof Error &&
            error.message.includes("failed to expand user dir")
          )
            continue;
          throw error;
        }
        const relativeTo = origin.startsWith("file:")
          ? dirname(relativeFile(checkout, configPath(origin.slice(5))))
          : checkout;
        const includePath = relativeFile(relativeTo, path);
        try {
          await rememberControl(includePath);
        } catch (error) {
          // Git's successful --includes read above already required access to
          // active includes. An inaccessible conditional path was not selected.
          if (
            key.startsWith("includeif.") &&
            (error as NodeJS.ErrnoException).code === "EACCES"
          ) {
            inaccessibleIncludes.add(includePath);
            continue;
          }
          throw error;
        }
      }
    }
    const hooks = relativeFile(
      checkout,
      (
        await runControl(root, checkout, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "hooks",
        ])
      ).replace(/\n$/u, ""),
    );
    const hookDirectory = await stat(hooks).catch(missing);
    if (hookDirectory !== undefined && !hookDirectory.isDirectory()) {
      // A file such as /dev/null disables hooks; keep that binding intact.
      await rememberControl(hooks);
    } else {
      // Remember absent entrypoints to reject newly installed hooks before Git.
      // Resolving each entry also protects executable symlink targets.
      for (const hook of GIT_HOOKS) await rememberControl(join(hooks, hook));
    }
  };
  const selectedDirectories: string[] = [];
  for (const argument of ["--absolute-git-dir", "--git-common-dir"]) {
    const output = await runControl(root, root, [
      "rev-parse",
      "--path-format=absolute",
      argument,
    ]);
    const path = await realControlPath(output.replace(/\n$/u, ""));
    selectedDirectories.push(path);
    await remember(path);
  }
  const selectedMarker = usesWorktreeMarker
    ? await markerDirectories(root, isGitDirectory)
    : undefined;
  const discover = async (capture: boolean): Promise<void> => {
    const protectedRoots = capture
      ? []
      : (
          await Promise.all(
            [...administrationRoots].map(async ([path, identity]) => {
              const metadata = await stat(path, { bigint: true }).catch(
                missing,
              );
              return metadata?.dev === identity.dev &&
                metadata.ino === identity.ino
                ? path
                : undefined;
            }),
          )
        ).filter((path): path is string => path !== undefined);
    if (!capture) {
      for (const path of inaccessibleIncludes) {
        try {
          const canonical = await canonicalPath(path);
          await stat(canonical).catch(missing);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EACCES") continue;
          throw error;
        }
        throw new Error(
          `Git conditional include became accessible during the patch: ${path}`,
        );
      }
      for (const [path, expected] of controlPaths) {
        const canonical = await canonicalPath(path);
        const metadata = await stat(canonical, { bigint: true }).catch(missing);
        if (
          canonical !== expected.canonical ||
          (![...administrationRoots.keys()].some((root) =>
            inside(root, expected.canonical),
          ) &&
            (metadata?.dev !== expected.identity?.dev ||
              metadata?.ino !== expected.identity?.ino))
        )
          throw new Error(
            `Git configuration or hooks changed location during the patch: ${path}`,
          );
      }
      const marker =
        selectedMarker === undefined
          ? undefined
          : await markerDirectories(root, isGitDirectory);
      if (
        selectedDirectories.some((path) => !protectedRoots.includes(path)) ||
        (selectedMarker !== undefined &&
          (marker === undefined ||
            marker.length !== selectedMarker.length ||
            marker.some((path, index) => path !== selectedMarker[index])))
      ) {
        throw new Error(
          "Selected Git administration changed during the patch. Inspect the checkout before retrying.",
        );
      }
    }
    const visited = new Set<string>();
    const visit = async (checkout: string): Promise<void> => {
      const canonical = await realControlPath(checkout);
      if (!inside(root, canonical))
        throw new Error(
          "Nested Git checkout resolves outside the selected repository.",
        );
      if (visited.has(canonical)) return;
      if (canonical !== root) {
        const directories = await markerDirectories(checkout, isGitDirectory);
        if (directories === undefined) return;
        if (capture) for (const path of directories) await remember(path);
        else if (
          directories.some(
            (path) => !protectedRoots.some((root) => inside(root, path)),
          )
        ) {
          throw new Error(
            `Patch selected Git metadata outside the pre-patch administration directories: ${checkout}`,
          );
        }
      }
      visited.add(canonical);
      if (capture) await captureReferences(checkout);
      const [tracked, untracked] = await Promise.all([
        runBytes(root, checkout, [
          "ls-files",
          "--cached",
          "--stage",
          "--full-name",
          "-z",
        ]),
        runBytes(root, checkout, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "--full-name",
          "-z",
        ]),
      ]);
      const candidates = new Map<string, boolean>();
      const add = async (
        path: string,
        directory: boolean,
        gitlink: boolean,
      ): Promise<void> => {
        const readable = await readableGitParent(
          checkout,
          Buffer.from(path, "latin1"),
          directory,
          gitlink,
        );
        if (readable === undefined) return;
        let candidate = resolve(checkout, readable.path);
        gitlink &&= readable.exact;
        while (candidate !== checkout && inside(checkout, candidate)) {
          candidates.set(
            candidate,
            (candidates.get(candidate) ?? false) || gitlink,
          );
          gitlink = false;
          candidate = dirname(candidate);
        }
      };
      for (const entry of tracked
        .toString("latin1")
        .split("\0")
        .filter(Boolean)) {
        const gitlink = entry.startsWith("160000 ");
        await add(entry.slice(entry.indexOf("\t") + 1), gitlink, gitlink);
      }
      for (const path of untracked
        .toString("latin1")
        .split("\0")
        .filter(Boolean))
        await add(path, path.endsWith("/"), false);
      const symlinkedAncestors: string[] = [];
      for (const [candidate, gitlink] of [...candidates].sort(
        ([a], [b]) => a.length - b.length,
      )) {
        if (symlinkedAncestors.some((ancestor) => inside(ancestor, candidate)))
          continue;
        if (
          !gitlink &&
          (await lstat(candidate).catch(missing))?.isSymbolicLink()
        ) {
          symlinkedAncestors.push(candidate);
          continue;
        }
        if (
          [...visited].some(
            (path) =>
              path !== canonical &&
              inside(canonical, path) &&
              inside(path, candidate),
          )
        )
          continue;
        if ((await lstat(join(candidate, ".git")).catch(missing)) !== undefined)
          await visit(candidate);
      }
    };
    await visit(root);
  };
  await discover(true);
  return {
    readOnlyPaths: [
      ...new Set([
        ...administrationRoots.keys(),
        ...[...controlPaths.values()]
          .filter(({ identity }) => identity !== undefined)
          .map(({ canonical }) => canonical)
          .filter(
            (path) =>
              ![...administrationRoots.keys()].some((root) =>
                inside(root, path),
              ),
          ),
      ]),
    ],
    validate: () => discover(false),
  };
}

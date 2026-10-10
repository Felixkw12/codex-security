import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
].flatMap((hook) =>
  process.platform === "win32" ? [hook, `${hook}.exe`] : [hook],
);

export interface PatchGitCommandOptions {
  readonly encoding?: "base64";
  readonly nestedProbe?: boolean;
  readonly indexFile?: string;
  readonly input?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

type RunGit = (
  root: string,
  directory: string,
  args: string[],
  options?: PatchGitCommandOptions,
) => Promise<string>;

type RunIndexGit = (
  args: string[],
  options?: PatchGitCommandOptions,
) => Promise<string>;

export async function withPatchGitIndex<T>(
  run: RunIndexGit,
  inspect: (run: RunIndexGit) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "codex-security-patch-tree-"));
  const indexFile = join(directory, "index");
  const indexed: RunIndexGit = (args, options) =>
    run(args, { ...options, indexFile });
  try {
    const heads = await indexed(["rev-parse", "--revs-only", "HEAD"]);
    await indexed(["read-tree", ...(heads.trim() ? ["HEAD"] : ["--empty"])]);
    const entries = await run(["ls-files", "--stage", "--full-name", "-z"]);
    await indexed(["update-index", "-z", "--index-info"], {
      input: entries.replaceAll(
        /(^|\0)([0-7]+ [a-f\d]+) [123]\t/gu,
        "$1$2 0\t",
      ),
    });
    return await inspect(indexed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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

function hasNoWorktree(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & {
    code?: unknown;
    status?: unknown;
    stderr?: unknown;
  };
  const diagnostic = Buffer.isBuffer(failure.stderr)
    ? failure.stderr.toString("utf8")
    : failure.stderr;
  return (
    (failure.code === 128 || failure.status === 128) &&
    typeof diagnostic === "string" &&
    /fatal: this operation must be run in a work tree\r?\n$/u.test(diagnostic)
  );
}

async function markerDirectories(
  directory: string,
  isGitDirectory: (path: string, contents?: Buffer | true) => Promise<boolean>,
  commonDirectory?: string,
): Promise<string[] | undefined> {
  const marker = join(directory, ".git");
  const contents = await readGitMarker(marker);
  if (contents === undefined) return undefined;
  if (!(await isGitDirectory(marker, contents))) return undefined;
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
  if (!(await stat(gitDirectory)).isDirectory()) return undefined;
  if (commonDirectory !== undefined) return [gitDirectory, commonDirectory];
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
  // Match realpath's Windows separators when a path no longer exists.
  if (sep === "\\") path = path.replaceAll("/", sep);
  // Some realpath implementations collapse file/.. even when lookup fails.
  const canonical = await stat(path)
    .then(() => realControlPath(path))
    .catch(missing);
  if (canonical !== undefined) return canonical;
  const parent = dirname(path);
  if (parent === path) return path;
  // A missing intermediate component must not collapse into an existing file.
  return `${await canonicalPath(parent)}${path.slice(parent.length)}`;
}

async function readableGitParent(
  checkout: string,
  path: Buffer,
  directory: boolean,
  gitlink: boolean,
  selectsGitDirectory: (
    directory: Buffer,
    markerContents: Buffer | true,
  ) => Promise<boolean>,
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
        (!gitlink ||
          !exact ||
          end !== path.length ||
          process.platform !== "win32") &&
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
    const rawCheckout = Buffer.concat([Buffer.from(`${checkout}${sep}`), path]);
    const marker = Buffer.concat([rawCheckout, Buffer.from(`${sep}.git`)]);
    const markerContents = await readGitMarker(marker);
    if (
      markerContents !== undefined &&
      (await selectsGitDirectory(rawCheckout, markerContents))
    )
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
  usesCommonDirectoryMarker = true,
): Promise<PatchGitControls | undefined> {
  const runBytes = async (
    root: string,
    checkout: string,
    args: string[],
    options?: PatchGitCommandOptions,
  ) =>
    Buffer.from(
      await run(root, checkout, args, { ...options, encoding: "base64" }),
      "base64",
    );
  const runControl = async (
    root: string,
    checkout: string,
    args: string[],
    options?: PatchGitCommandOptions,
  ) => controlPathText(await runBytes(root, checkout, args, options));
  // GIT_CONFIG selects a file only for git-config, not snapshot bookkeeping.
  const configurationEnvironment = { GIT_CONFIG: undefined };
  // Config records contain unrelated keys too. Split bytes before decoding paths.
  const runConfigFields = async (checkout: string, args: string[]) =>
    (
      await runBytes(root, checkout, args, {
        environment: configurationEnvironment,
      })
    )
      .toString("latin1")
      .split("\0");
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
  const isGitDirectory = async (
    path: string,
    markerContents?: Buffer | true,
    nestedProbe = false,
  ): Promise<boolean> => {
    let administration: Buffer | undefined = Buffer.from(path);
    if (Buffer.isBuffer(markerContents)) {
      let target = markerContents.subarray(8);
      while (target.at(-1) === 10 || target.at(-1) === 13)
        target = target.subarray(0, -1);
      administration =
        target.length === 0
          ? undefined
          : isAbsolute(target.toString("latin1"))
            ? target
            : Buffer.concat([Buffer.from(`${dirname(path)}${sep}`), target]);
    }
    if (administration !== undefined) {
      for (const name of ["HEAD", "commondir"]) {
        const metadataPath = Buffer.concat([
          administration,
          Buffer.from(`${sep}${name}`),
        ]);
        const metadata = await stat(metadataPath).catch(missing);
        if (metadata && !metadata.isFile() && !metadata.isDirectory())
          throw new Error(
            `Patch cannot safely inspect non-regular Git metadata: ${metadataPath.toString("utf8")}`,
          );
      }
    }
    // Git's early gitfile reader finds relative targets using slash separators.
    const gitPath =
      process.platform === "win32" ? path.replaceAll("\\", "/") : path;
    try {
      // This early rev-parse mode only checks filesystem structure. It does not
      // select the candidate repository or load its configuration and hooks.
      await runBytes(root, root, ["rev-parse", "--resolve-git-dir", gitPath], {
        nestedProbe,
      });
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
      const negatives = [
        `fatal: not a gitdir '${gitPath}'`,
        `fatal: gitfile does not point to a valid repository: ${gitPath}`,
        `fatal: no path in gitfile: ${gitPath}`,
      ];
      if (Buffer.isBuffer(markerContents)) {
        // This text is used only to recognize Git's diagnostic, never as a path
        // for filesystem access. Match the subprocess's UTF-8 error decoding.
        const configured = markerContents
          .subarray(8)
          .toString("utf8")
          .replace(/[\r\n]+$/u, "");
        const target = isAbsolute(configured)
          ? configured
          : `${gitPath.slice(0, gitPath.lastIndexOf("/") + 1)}${configured}`;
        negatives.push(`fatal: not a git repository: ${target}`);
      }
      if (
        (failure.code === 128 || failure.status === 128) &&
        typeof diagnostic === "string" &&
        negatives.some(
          (negative) =>
            diagnostic.endsWith(`${negative}\n`) ||
            diagnostic.endsWith(`${negative}\r\n`),
        )
      )
        return false;
      throw error;
    }
  };
  const rawCheckoutSelectsGit = async (
    checkout: Buffer,
    markerContents: Buffer | true,
  ): Promise<boolean> => {
    const temporary = await mkdtemp(
      join(tmpdir(), "codex-security-git-marker-"),
    );
    try {
      const alias = join(temporary, "checkout");
      // The symlink preserves byte names and relative gitfile resolution while
      // giving the native filesystem-only probe a representable argument.
      await symlink(checkout, alias);
      return await isGitDirectory(join(alias, ".git"), markerContents, true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  const administrationRoots = new Map<string, { dev: bigint; ino: bigint }>();
  const remember = async (path: string): Promise<void> => {
    const metadata = await stat(path, { bigint: true });
    administrationRoots.set(path, { dev: metadata.dev, ino: metadata.ino });
  };
  const controlPaths = new Map<
    string,
    {
      canonical: string;
      identity: { dev: bigint; ino: bigint } | undefined;
      directory: boolean | undefined;
      readOnly: boolean;
      allowDirectoryChanges: boolean;
    }
  >();
  const inaccessibleIncludes = new Set<string>();
  const inaccessibleHooks = new Set<string>();
  const hookIsAvailable = async (path: string): Promise<boolean> => {
    const executable = await access(path, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (!executable) return false;
    const metadata = await stat(path).catch(missing);
    return metadata !== undefined && !metadata.isDirectory();
  };
  const rememberControl = async (
    path: string,
    protectDirectory = true,
  ): Promise<void> => {
    const canonical = await canonicalPath(path);
    const metadata = await stat(canonical, { bigint: true }).catch(missing);
    const directory = metadata?.isDirectory();
    const previous = controlPaths.get(path);
    controlPaths.set(path, {
      canonical,
      identity: metadata && { dev: metadata.dev, ino: metadata.ino },
      directory,
      readOnly: protectDirectory || !directory || previous?.readOnly === true,
      allowDirectoryChanges:
        !protectDirectory && previous?.allowDirectoryChanges !== false,
    });
  };
  const rememberHook = async (path: string): Promise<void> => {
    if (await hookIsAvailable(path)) {
      await rememberControl(path, false);
    } else {
      // Git ignores inactive entries; reject their activation before bookkeeping.
      inaccessibleHooks.add(path);
    }
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
            await runControl(
              root,
              checkout,
              [
                "-c",
                `codexsecurity.patchcontrolpath=${path}`,
                "config",
                "--null",
                "--type=path",
                "--get",
                "codexsecurity.patchcontrolpath",
              ],
              { environment: configurationEnvironment },
            )
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
          await rememberControl(includePath, !key.startsWith("includeif."));
        } catch (error) {
          // Git's successful --includes read above already required access to
          // active includes. An inaccessible conditional path was not selected.
          if (
            key.startsWith("includeif.") &&
            ["EACCES", "ELOOP"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            inaccessibleIncludes.add(includePath);
            continue;
          }
          throw error;
        }
      }
    }
    // A complete entry preserves Git's empty hooksPath semantics; querying
    // only the hooks directory would turn that setting into the checkout.
    const hooks = relativeFile(
      checkout,
      dirname(
        (
          await runControl(root, checkout, [
            "rev-parse",
            "--git-path",
            "hooks/post-index-change",
          ])
        ).replace(/\n$/u, ""),
      ),
    );
    // A non-directory hooks parent is ordinary data. Bind its absent entries
    // so validation detects hooks added after it becomes a directory.
    for (const hook of GIT_HOOKS) await rememberHook(relativeFile(hooks, hook));
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
  const selectedCommonDirectory = usesCommonDirectoryMarker
    ? undefined
    : selectedDirectories[1];
  for (const argument of [
    ...(usesWorktreeMarker ? [] : ["--git-dir"]),
    ...(usesCommonDirectoryMarker ? [] : ["--git-common-dir"]),
  ]) {
    await rememberControl(
      relativeFile(
        root,
        (await runControl(root, root, ["rev-parse", argument])).replace(
          /\n$/u,
          "",
        ),
      ),
    );
  }
  const selectedMarker = usesWorktreeMarker
    ? await markerDirectories(root, isGitDirectory, selectedCommonDirectory)
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
      for (const path of inaccessibleHooks) {
        if (await hookIsAvailable(path))
          throw new Error(
            `Git hook became accessible during the patch: ${path}`,
          );
      }
      for (const path of inaccessibleIncludes) {
        try {
          const canonical = await canonicalPath(path);
          const metadata = await stat(canonical).catch(missing);
          if (metadata === undefined || metadata.isDirectory()) continue;
        } catch (error) {
          if (
            ["EACCES", "ELOOP"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            continue;
          throw error;
        }
        throw new Error(
          `Git conditional include became accessible during the patch: ${path}`,
        );
      }
      for (const [path, expected] of controlPaths) {
        const canonical = await canonicalPath(path);
        const metadata = await stat(canonical, { bigint: true }).catch(missing);
        // An absent entry or directory cannot supply hook/configuration bytes.
        // Keep file activation and overlapping configuration roles bound.
        if (
          expected.allowDirectoryChanges &&
          (expected.identity === undefined || expected.directory === true) &&
          (metadata === undefined || metadata.isDirectory())
        )
          continue;
        if (
          canonical !== expected.canonical ||
          (![...administrationRoots.keys()].some((root) =>
            inside(root, expected.canonical),
          ) &&
            (metadata?.dev !== expected.identity?.dev ||
              metadata?.ino !== expected.identity?.ino ||
              metadata?.isDirectory() !== expected.directory))
        )
          throw new Error(
            `Git configuration or hooks changed location during the patch: ${path}`,
          );
      }
      const marker =
        selectedMarker === undefined
          ? undefined
          : await markerDirectories(
              root,
              isGitDirectory,
              selectedCommonDirectory,
            );
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
      let naturalWorktree = true;
      if (canonical !== root) {
        const directories = await markerDirectories(
          checkout,
          (path, contents) => isGitDirectory(path, contents, true),
        );
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
        const config = join(directories.at(-1)!, "config");
        if ((await stat(config).catch(missing))?.isFIFO())
          throw new Error(
            `Patch cannot safely inspect non-regular Git metadata: ${config}`,
          );
        let worktree: string | undefined;
        try {
          worktree = await realControlPath(
            (
              await runControl(root, checkout, ["rev-parse", "--show-toplevel"])
            ).replace(/\n$/u, ""),
          );
        } catch (error) {
          if (!hasNoWorktree(error)) throw error;
          naturalWorktree = false;
        }
        if (worktree !== undefined && relative(canonical, worktree) !== "")
          throw new Error(
            "Git's worktree root does not match the selected checkout's .git marker. Select the intended checkout explicitly or fix its Git configuration.",
          );
      }
      if (capture) await captureReferences(checkout);
      let tracked: Buffer;
      let untracked: Buffer;
      try {
        [tracked, untracked] = await withPatchGitIndex(
          (args, options) =>
            run(
              root,
              checkout,
              [
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                ...args,
              ],
              options,
            ),
          async (indexed) => {
            const outputs = await Promise.all([
              indexed(
                ["ls-files", "--cached", "--stage", "--full-name", "-z"],
                {
                  encoding: "base64",
                },
              ),
              indexed(
                [
                  "ls-files",
                  "--others",
                  "--exclude-standard",
                  "--full-name",
                  "-z",
                ],
                {
                  encoding: "base64",
                },
              ),
            ]);
            return outputs.map((output) => Buffer.from(output, "base64")) as [
              Buffer,
              Buffer,
            ];
          },
        );
      } catch (error) {
        if (!naturalWorktree && hasNoWorktree(error)) return;
        throw error;
      }
      visited.add(canonical);
      const candidates = new Map<
        string,
        { gitlink: boolean; selected: boolean }
      >();
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
          rawCheckoutSelectsGit,
        );
        if (readable === undefined) return;
        let candidate = resolve(checkout, readable.path);
        gitlink &&= readable.exact;
        while (candidate !== checkout && inside(checkout, candidate)) {
          const previous = candidates.get(candidate);
          candidates.set(candidate, {
            gitlink: (previous?.gitlink ?? false) || gitlink,
            selected: (previous?.selected ?? false) || readable.exact,
          });
          gitlink = false;
          readable.exact = false;
          candidate = dirname(candidate);
        }
      };
      for (const entry of tracked
        .toString("latin1")
        .split("\0")
        .filter(Boolean)) {
        if (entry.startsWith("160000 "))
          await add(entry.slice(entry.indexOf("\t") + 1), true, true);
      }
      for (const path of untracked
        .toString("latin1")
        .split("\0")
        .filter(Boolean))
        if (path.endsWith("/")) await add(path, true, false);
      const symlinkedAncestors: string[] = [];
      for (const [candidate, { gitlink, selected }] of [...candidates].sort(
        ([a], [b]) => a.length - b.length,
      )) {
        if (symlinkedAncestors.some((ancestor) => inside(ancestor, candidate)))
          continue;
        // Git for Windows follows directory junctions as directories.
        if (
          (!gitlink || process.platform !== "win32") &&
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
        if (
          selected &&
          (await lstat(join(candidate, ".git")).catch(missing)) !== undefined
        )
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
          .filter(
            ({ identity, readOnly }) => identity !== undefined && readOnly,
          )
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

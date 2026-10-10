import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type RunGit = (
  root: string,
  directory: string,
  args: string[],
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

// Append before realpath so a link/.. path keeps the filesystem's meaning.
const relativeFile = (directory: string, path: string) =>
  isAbsolute(path) ? path : `${directory}${sep}${path}`;

async function markerDirectories(
  directory: string,
): Promise<string[] | undefined> {
  const marker = join(directory, ".git");
  const metadata = await stat(marker).catch(missing);
  if (metadata === undefined) return undefined;
  let gitDirectory: string;
  if (metadata.isDirectory()) gitDirectory = await realpath(marker);
  else {
    const contents = await readFile(marker, "utf8");
    if (!contents.startsWith("gitdir: "))
      throw new Error(`Invalid Git metadata marker: ${marker}`);
    gitDirectory = await realpath(
      relativeFile(directory, contents.slice(8).replace(/[\r\n]+$/u, "")),
    );
  }
  const common = await readFile(join(gitDirectory, "commondir"), "utf8").catch(
    missing,
  );
  return common === undefined
    ? [gitDirectory]
    : [
        gitDirectory,
        await realpath(
          relativeFile(gitDirectory, common.replace(/[\r\n]+$/u, "")),
        ),
      ];
}

// Git permits include files and hook directories that do not exist yet.
async function canonicalPath(path: string): Promise<string> {
  const canonical = await realpath(path).catch(missing);
  if (canonical !== undefined) return canonical;
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await canonicalPath(parent), path.slice(parent.length));
}

export async function capturePatchGitControls(
  directory: string,
  run: RunGit,
  usesWorktreeMarker: boolean,
): Promise<PatchGitControls | undefined> {
  let root: string;
  try {
    const output = await run(directory, directory, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (output.length === 0) return undefined;
    root = await realpath(output.replace(/\n$/u, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("not a git repository") ||
      message.toLowerCase() === "git is not available on a trusted path."
    )
      return undefined;
    throw error;
  }
  const administrationRoots = new Map<string, { dev: bigint; ino: bigint }>();
  const remember = async (path: string): Promise<void> => {
    const metadata = await stat(path, { bigint: true });
    administrationRoots.set(path, { dev: metadata.dev, ino: metadata.ino });
  };
  const controlPaths = new Map<
    string,
    { canonical: string; identity: { dev: bigint; ino: bigint } | undefined }
  >();
  const rememberControl = async (path: string): Promise<void> => {
    const canonical = await canonicalPath(path);
    const metadata = await stat(canonical, { bigint: true }).catch(missing);
    controlPaths.set(path, {
      canonical,
      identity: metadata && { dev: metadata.dev, ino: metadata.ino },
    });
  };
  const captureReferences = async (checkout: string): Promise<void> => {
    const origins = (
      await run(root, checkout, [
        "config",
        "--null",
        "--show-origin",
        "--includes",
        "--list",
        "--name-only",
      ])
    ).split("\0");
    let includes = false;
    for (let index = 0; index + 1 < origins.length; index += 2) {
      const origin = origins[index]!;
      if (origin.startsWith("file:"))
        await rememberControl(relativeFile(checkout, origin.slice(5)));
      if (/^(include|includeif\..*)\.path$/u.test(origins[index + 1]!))
        includes = true;
    }
    if (includes) {
      const paths = (
        await run(root, checkout, [
          "config",
          "--null",
          "--show-origin",
          "--includes",
          "--type=path",
          "--get-regexp",
          "^(include|includeif\\..*)\\.path$",
        ])
      ).split("\0");
      for (let index = 0; index + 1 < paths.length; index += 2) {
        const origin = paths[index]!;
        const value = paths[index + 1]!;
        const path = value.slice(value.indexOf("\n") + 1);
        if (path.length === 0) continue;
        const relativeTo = origin.startsWith("file:")
          ? dirname(relativeFile(checkout, origin.slice(5)))
          : checkout;
        await rememberControl(relativeFile(relativeTo, path));
      }
    }
    const hooks = relativeFile(
      checkout,
      (
        await run(root, checkout, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "hooks",
        ])
      ).replace(/\n$/u, ""),
    );
    await rememberControl(hooks);
    for (const entry of (await readdir(hooks, { withFileTypes: true }).catch(
      missing,
    )) ?? []) {
      // Git can execute a symlinked hook outside the configured directory.
      if (entry.isSymbolicLink())
        await rememberControl(join(hooks, entry.name));
    }
  };
  const selectedDirectories: string[] = [];
  for (const argument of ["--absolute-git-dir", "--git-common-dir"]) {
    const output = await run(root, root, [
      "rev-parse",
      "--path-format=absolute",
      argument,
    ]);
    const path = await realpath(output.replace(/\n$/u, ""));
    selectedDirectories.push(path);
    await remember(path);
  }
  const selectedMarker = usesWorktreeMarker
    ? await markerDirectories(root)
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
          : await markerDirectories(root);
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
      const canonical = await realpath(checkout);
      if (!inside(root, canonical))
        throw new Error(
          "Nested Git checkout resolves outside the selected repository.",
        );
      if (visited.has(canonical)) return;
      visited.add(canonical);
      if (canonical !== root) {
        const directories = await markerDirectories(checkout);
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
      if (capture) await captureReferences(checkout);
      const [tracked, untracked] = await Promise.all([
        run(root, checkout, [
          "ls-files",
          "--cached",
          "--stage",
          "--full-name",
          "-z",
        ]),
        run(root, checkout, [
          "ls-files",
          "--others",
          "--directory",
          "--exclude-standard",
          "--full-name",
          "-z",
        ]),
      ]);
      const candidates = new Set<string>();
      const add = (path: string, directory: boolean): void => {
        let candidate = resolve(checkout, path);
        if (!directory) candidate = dirname(candidate);
        while (candidate !== checkout && inside(checkout, candidate)) {
          candidates.add(candidate);
          candidate = dirname(candidate);
        }
      };
      for (const entry of tracked.split("\0").filter(Boolean))
        add(entry.slice(entry.indexOf("\t") + 1), entry.startsWith("160000 "));
      for (const path of untracked.split("\0").filter(Boolean))
        add(path, path.endsWith("/"));
      for (const candidate of [...candidates].sort(
        (a, b) => a.length - b.length,
      )) {
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
        ...[...controlPaths.values()].map(({ canonical }) => canonical),
      ]),
    ],
    validate: () => discover(false),
  };
}

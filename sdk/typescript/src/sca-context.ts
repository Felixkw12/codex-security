import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { isRecord } from "./record.js";
import { relativePathIsOutside } from "./targets.js";
import type { ScaPackageContext, ScaResult } from "./sca-types.js";

interface Package {
  path: string;
  name: string;
  version: string;
  manifest: Record<string, unknown>;
}

async function readPackage(
  path: string,
  repository: string,
  project = false,
): Promise<Package | null> {
  try {
    const canonical = await realpath(join(path, "package.json"));
    if (relativePathIsOutside(relative(repository, canonical))) return null;
    if (!(await stat(canonical)).isFile()) return null;
    const manifest: unknown = JSON.parse(await readFile(canonical, "utf8"));
    if (
      !isRecord(manifest) ||
      (!project && typeof manifest["name"] !== "string")
    )
      return null;
    return {
      path: dirname(canonical),
      name:
        typeof manifest["name"] === "string"
          ? manifest["name"]
          : basename(path),
      version:
        typeof manifest["version"] === "string"
          ? manifest["version"]
          : "unknown",
      manifest,
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR" ||
      (error as NodeJS.ErrnoException).code === "EISDIR" ||
      (error as NodeJS.ErrnoException).code === "ELOOP" ||
      (error as NodeJS.ErrnoException).code === "EACCES" ||
      (error as NodeJS.ErrnoException).code === "EPERM" ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  }
}

async function resolvePackage(
  from: string,
  name: string,
  repository: string,
): Promise<Package | null> {
  let directory = from;
  while (!relativePathIsOutside(relative(repository, directory))) {
    const modules = join(directory, "node_modules");
    const candidate = join(modules, name);
    if (relativePathIsOutside(relative(modules, candidate))) return null;
    try {
      await lstat(candidate);
      // A nearer installed package shadows hoisted copies even when its
      // manifest cannot be inspected within this repository.
      return await readPackage(candidate, repository);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "ELOOP")
        return null;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** Resolve installed npm evidence without importing code, installing, or using the network. */
export async function dependencyPackageContexts(
  result: ScaResult,
  signal?: AbortSignal,
): Promise<ScaPackageContext[]> {
  const repository = result.repository.path;
  const matched = new Set(result.matches.map((match) => match.componentId));
  const components = result.components.filter((component) =>
    matched.has(component.id),
  );
  const contexts = components.map((component): ScaPackageContext => ({
    componentId: component.id,
    manifestPath: null,
    projectName: null,
    private: null,
    installedPath: null,
    dependencyChain: [],
    dependencyGroups: [...component.dependencyGroups],
    limitations: [],
  }));
  const files = new Set(
    components
      .filter((component) => component.ecosystem === "npm")
      .map((component) => component.sourcePath),
  );
  for (const file of files) {
    signal?.throwIfAborted();
    const project = await readPackage(
      dirname(join(repository, file)),
      repository,
      true,
    );
    const selected = components.filter(
      (component) =>
        component.sourcePath === file && component.ecosystem === "npm",
    );
    for (const component of selected) {
      const context = contexts.find(
        (item) => item.componentId === component.id,
      )!;
      if (project !== null) {
        context.manifestPath = relative(
          repository,
          join(project.path, "package.json"),
        );
        context.projectName =
          typeof project.manifest["name"] === "string" ? project.name : null;
        context.private = project.manifest["private"] === true;
      }
    }
    if (project === null) continue;
    const queue: {
      pkg: Package;
      chain: ScaPackageContext["dependencyChain"];
      groups: string[];
    }[] = [{ pkg: project, chain: [], groups: [] }];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      signal?.throwIfAborted();
      const { pkg, chain, groups } = queue[index]!;
      if (visited.has(pkg.path)) continue;
      visited.add(pkg.path);
      const current = [
        ...chain,
        {
          name: pkg.name,
          version: pkg.version,
          path: relative(repository, pkg.path) || ".",
        },
      ];
      for (const component of selected) {
        const context = contexts.find(
          (item) => item.componentId === component.id,
        )!;
        if (
          chain.length > 0 &&
          context.installedPath === null &&
          component.name === pkg.name &&
          component.version === pkg.version
        ) {
          context.installedPath = relative(repository, pkg.path);
          context.dependencyChain = current;
          context.dependencyGroups = [
            ...new Set([...context.dependencyGroups, ...groups]),
          ];
        }
      }
      if (
        selected.every(
          (component) =>
            contexts.find((context) => context.componentId === component.id)!
              .installedPath !== null,
        )
      )
        break;
      const fields =
        index === 0
          ? ["dependencies", "optionalDependencies", "devDependencies"]
          : ["dependencies", "optionalDependencies", "peerDependencies"];
      for (const field of fields) {
        const dependencies = pkg.manifest[field];
        if (!isRecord(dependencies)) continue;
        for (const name of Object.keys(dependencies)) {
          const dependency = await resolvePackage(pkg.path, name, repository);
          if (dependency !== null && !visited.has(dependency.path))
            queue.push({
              pkg: dependency,
              chain: current,
              groups:
                index === 0
                  ? [
                      field === "devDependencies"
                        ? "dev"
                        : field === "optionalDependencies"
                          ? "optional"
                          : "runtime",
                    ]
                  : groups,
            });
        }
      }
    }
  }
  for (const context of contexts) {
    const component = components.find(
      (item) => item.id === context.componentId,
    )!;
    context.limitations.push(
      context.installedPath === null
        ? "No matching installed source was resolved automatically; use the dependency file and inspect available source before concluding it is unavailable."
        : "This is one observed local dependency chain, not a complete graph or evidence of deployment or attacker reachability.",
    );
    if (component.ecosystem !== "npm")
      context.limitations.push(
        "Automatic installed-source resolution currently supports npm and pnpm projects.",
      );
  }
  return contexts;
}

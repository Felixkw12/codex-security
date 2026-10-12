// Native temporary-directory grants must stay inside the owning fixture.
export function patchSnapshotEnvironment(
  temporaryDirectory: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => !["TEMP", "TMP", "TMPDIR"].includes(name.toUpperCase()),
      ),
    ),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
}

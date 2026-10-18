# Windows write-carveout comparison

This diagnostic compares the native Windows write-deny guard at public
[`openai/codex` commit 83086188](https://github.com/openai/codex/tree/83086188ae0614bd882818ff1aa23f3194962012)
with one candidate change. The source and Rust 1.95.0 are pinned. Both variants use
the same added tests, locked dependencies, build configuration and released
0.163.0 CLI/command runner. Only the sibling setup helper is replaced in separate
copies of the complete native package. The SDK/package pins remain unchanged.

`guard.patch` makes a requested write carveout require an explicit effective
deny. An inherited deny can follow an inherited allow from a nearer parent.
The write mask, SID selection, read-deny logic and existing error paths remain
unchanged. Inherited-only coverage without `WRITE_DAC` now returns the original
update-open error; that compatibility cost needs acceptance before shipping.
Existing callers handle update errors differently, so this is not a claim that
every caller fails closed.

`tests.patch` retains the five released ACL tests and adds three cases:

- Both ancestor orders must add an explicit hook deny and remain idempotent.
- An existing explicit target deny remains a successful no-op without
  `WRITE_DAC`.
- An inherited-only target deny requires an update and returns its actual access
  error when `WRITE_DAC` is unavailable.

The compatibility fixtures retain the original DACL and an already granted
update handle. On their own temporary files they add noninheriting OWNER RIGHTS
entries, prove fresh read access succeeds and update access is denied, then
restore the original DACL/protection through the retained handle. Restoration
also runs during panic unwinding. Process abort cannot run destructors.

The original native module is expected to report six passes and two specific
assertion failures; the candidate is expected to pass all eight. Compile errors,
fixture-precondition failures, ignored cases and other failures are not accepted
as the expected control result. Actual raw logs and return codes are retained.

Both staged helpers then run the same four existing hook tests with their
original assertions and timeouts. The control must reproduce the hook-overwrite
assertion in at least one of the standard or nested cases, with configured and
worktree passing. Earlier controls varied between either failure and both;
an all-pass control or another failure makes the comparison inconclusive.
The candidate must pass all four. Filtered cases in Bun's JUnit report remain
skipped; no other case may execute. The existing observer records the actual CLI
launch, delivered profiles and synthetic ACL observations. The direct-sibling
setup lookup establishes helper selection by source inference, not child-image
telemetry. This experiment covers the elevated, non-registered setup route;
it does not validate legacy CLI-linked or registered-service provisioning.

The workflow retains the matching plugin-native artifact, Windows elevation
setup and test environment. Reports contain the exact source/build/runtime
hashes, both built setup helpers, raw logs and separate JUnit files. A successful
comparison would establish a bounded candidate result, not a released fix or
green PR CI. The optional-cache transition and Linux Git LFS failures remain
separate.

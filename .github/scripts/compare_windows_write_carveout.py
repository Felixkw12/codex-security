"""Compare one native Windows carveout candidate on the diagnostic workflow."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / "sdk/typescript"
SOURCE = ROOT / ".native-write-carveout-source"
FIXTURE = ROOT / ".github/fixtures/windows-write-carveout"
REPORTS = SDK / "reports/windows-write-carveout"
PIN = "83086188ae0614bd882818ff1aa23f3194962012"
TARGET = "x86_64-pc-windows-msvc"
GUARD = "codex-rs/windows-sandbox-rs/src/acl.rs"
TESTS = "codex-rs/windows-sandbox-rs/src/acl_tests.rs"
BASE_HASHES = {
    GUARD: "2b4685cb4a3ed79e124c113b5ded7c4fcc6fd5456c7e44a73df145d0fd25c666",
    TESTS: "f9818da36093f6550ff241f881d7f310ddd19554137611ba18ffdfd220c1d01c",
}
ORDERING = "acl::tests::write_carveout_adds_an_explicit_deny_in_either_ancestor_order"
INHERITED = "acl::tests::inherited_write_deny_without_write_dac_requires_update"
HOOK_PREFIX = (
    "snapshot filters can write LFS data while overlapping hooks stay protected: "
)
MODES = {"standard", "nested", "configured", "worktree"}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_hashes(path: Path) -> dict[str, str]:
    return {
        file.relative_to(path).as_posix(): digest(file)
        for file in sorted(path.rglob("*"))
        if file.is_file()
    }


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def native_result(raw: bytes, expected: set[str], control: bool) -> dict:
    text = "\n".join(raw.decode("utf-8").splitlines())
    started = re.findall(r"(?m)^test (acl::tests::\w+) \.\.\.", text)
    failed = set(re.findall(r"(?m)^    (acl::tests::\w+)$", text))
    summary = re.search(
        r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;",
        text,
    )
    intended = {ORDERING, INHERITED} if control else set()
    valid = (
        set(started) == expected
        and len(started) == len(expected)
        and failed == intended
        and summary is not None
        and tuple(map(int, summary.groups()[1:]))
        == (len(expected) - len(intended), len(intended), 0)
        and "restoring temporary target DACL failed:" not in text
    )
    if control:
        valid = valid and all(
            message in text
            for message in (
                "requested hook carveout must add an explicit deny",
                "an inherited-only deny still requires an explicit target update",
            )
        )
    return {"valid": valid, "started": started, "failed": sorted(failed)}


def hook_result(report: Path, raw: bytes, command: Path) -> dict:
    reported = ET.parse(report).findall(".//testcase")
    cases = [case for case in reported if case.attrib["name"].startswith(HOOK_PREFIX)]
    require(
        all(case.find("skipped") is not None for case in reported if case not in cases),
        "Unexpected case executed outside the hook selection",
    )
    modes = [case.attrib["name"].removeprefix(HOOK_PREFIX) for case in cases]
    require(set(modes) == MODES and len(modes) == 4, "Expected four hook cases")
    require(all(case.find("skipped") is None for case in cases), "Hook case skipped")
    failed = [
        mode
        for mode, case in zip(modes, cases, strict=True)
        if case.find("failure") is not None or case.find("error") is not None
    ]
    overwrite_failures = [
        mode
        for mode, case in zip(modes, cases, strict=True)
        if (failure := case.find("failure")) is not None
        and '- "#!/bin/sh\n- exit 0\n- "\n+ "changed"'
        in failure.attrib.get("message", "")
    ]
    records = [
        json.loads(line)
        for line in raw.decode("utf-8").splitlines()
        if line.startswith('{"mode":')
    ]
    require(
        {record["mode"] for record in records} == MODES and len(records) == 4,
        "Expected four fixture delivery records",
    )
    for record in records:
        require(bool(record["launches"]), "Fixture did not observe a native launch")
        for launch in record["launches"]:
            require(
                Path(launch["command"]).resolve() == command.resolve(),
                "Observed native command differs from the staged CLI",
            )
            config = tomllib.loads(launch["baseConfig"])
            require(
                config["windows"]["sandbox"] == "elevated",
                "Fixture did not deliver the elevated Windows configuration",
            )
    return {
        "failed": sorted(failed),
        "overwrite_failures": sorted(overwrite_failures),
        "observations": records,
    }


def main() -> None:
    require(sys.platform == "win32", "This experiment requires Windows")
    require(
        os.environ.get("CODEX_WINDOWS_REGISTERED_CORE") != "1",
        "The helper experiment does not cover registered Core",
    )
    REPORTS.mkdir(parents=True, exist_ok=False)
    manifest: dict = {
        "source_commit": PIN,
        "target": TARGET,
        "commands": [],
        "registered_core_requested": False,
        "helper_selection": "Source inference from direct sibling lookup; not child-image telemetry",
    }

    def save() -> None:
        (REPORTS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    def run(
        name: str, args: list[str], cwd: Path = ROOT, env: dict | None = None
    ) -> tuple[int, bytes]:
        path = REPORTS / f"{name}.log"
        record = {"name": name, "argv": args, "cwd": str(cwd), "log": path.name}
        manifest["commands"].append(record)
        save()
        with (
            path.open("wb") as log,
            subprocess.Popen(
                args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
            ) as process,
        ):
            assert process.stdout is not None
            while chunk := process.stdout.read1(65536):
                log.write(chunk)
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            code = process.wait()
        record.update(returncode=code, sha256=digest(path))
        save()
        return code, path.read_bytes()

    def checked(
        name: str, args: list[str], cwd: Path = ROOT, env: dict | None = None
    ) -> bytes:
        code, raw = run(name, args, cwd, env)
        require(code == 0, f"{name} failed with exit {code}")
        return raw

    try:
        manifest["wrapper_commit"] = (
            checked("wrapper-head", ["git", "rev-parse", "HEAD"]).decode().strip()
        )
        require(
            manifest["wrapper_commit"] == os.environ["GITHUB_SHA"],
            "Wrapper checkout differs from dispatched commit",
        )
        require(
            checked("native-head", ["git", "rev-parse", "HEAD"], SOURCE)
            .decode()
            .strip()
            == PIN,
            "Native source commit differs from the reviewed release",
        )
        require(
            not checked(
                "native-clean", ["git", "status", "--porcelain"], SOURCE
            ).strip(),
            "Native checkout already contains changes",
        )
        require(
            {name: digest(SOURCE / name) for name in BASE_HASHES} == BASE_HASHES,
            "Native guard/test source differs from reviewed literal bytes",
        )
        hook = SDK / "tests-ts/cli-patch-snapshot-context.test.ts"
        require(
            digest(hook)
            == "102fd11200b386372be57c0fed11f856904b5fd9b40ffc27bfb2431494e4318c",
            "Hook assertions or observer changed",
        )
        manifest["inputs"] = {
            str(path.relative_to(ROOT)): digest(path)
            for path in (
                Path(__file__),
                FIXTURE / "guard.patch",
                FIXTURE / "tests.patch",
                hook,
                SDK / "pnpm-lock.yaml",
            )
        }
        native_inputs = {
            name: digest(SOURCE / name)
            for name in (
                GUARD,
                TESTS,
                "codex-rs/Cargo.lock",
                "codex-rs/rust-toolchain.toml",
                "codex-rs/windows-sandbox-rs/Cargo.toml",
                "codex-rs/windows-sandbox-rs/build.rs",
            )
        }
        manifest["native_original_inputs"] = native_inputs
        toolchain = tomllib.loads((SOURCE / "codex-rs/rust-toolchain.toml").read_text())
        require(
            toolchain["toolchain"]["channel"] == "1.95.0", "Unexpected Rust toolchain"
        )
        checked("rust-toolchain", ["rustc", "+1.95.0", "--version", "--verbose"])
        checked("cargo-version", ["cargo", "+1.95.0", "--version"])
        resolution = checked(
            "resolve-native-package",
            [
                "bun",
                "--eval",
                """
import {createRequire} from "node:module";
import {resolveBundledCodexExecutable} from "./src/codex-sdk-environment.ts";
const cliPackage = createRequire(import.meta.url).resolve("@openai/codex/package.json");
const nativePackage = createRequire(cliPackage).resolve("@openai/codex-win32-x64/package.json");
process.stdout.write(JSON.stringify({command:resolveBundledCodexExecutable(),cliPackage,nativePackage}));
""",
            ],
            SDK,
        )
        resolved = json.loads(resolution)
        package_json = Path(resolved["nativePackage"])
        metadata = json.loads(package_json.read_text())
        require(
            metadata["name"] == "@openai/codex"
            and metadata["version"] == "0.163.0-win32-x64",
            "Unexpected native package",
        )
        package = package_json.parent.resolve()
        command_relative = Path(resolved["command"]).resolve().relative_to(package)
        checked("official-cli-version", [resolved["command"], "--version"])
        checked("git-version", ["git", "--version"])
        checked("bun-version", ["bun", "--version"])
        checked("node-version", ["node", "--version"])
        original_hashes = tree_hashes(package)
        manifest["official_package"] = {
            "metadata": metadata,
            "files": original_hashes,
            "cli_package_sha256": digest(Path(resolved["cliPackage"])),
        }
        stage = Path(tempfile.mkdtemp(prefix=".native-write-carveout-", dir=ROOT))
        manifest["staging_root"] = str(stage)
        build = Path(
            tempfile.mkdtemp(prefix="carveout-build-", dir=os.environ["RUNNER_TEMP"])
        )
        manifest["build_root"] = str(build)
        build_env = {**os.environ, "CARGO_TARGET_DIR": str(build)}
        checked("apply-tests", ["git", "apply", str(FIXTURE / "tests.patch")], SOURCE)
        tests_hash = digest(SOURCE / TESTS)
        expected_tests = {
            f"acl::tests::{name}"
            for name in re.findall(
                r"(?m)^#\[test\]\nfn (\w+)\(", (SOURCE / TESTS).read_text()
            )
        }
        require({ORDERING, INHERITED} <= expected_tests, "Missing reviewed regressions")
        manifest["expected_native_tests"] = sorted(expected_tests)
        comparisons = {}
        for variant in ("control", "candidate"):
            if variant == "candidate":
                checked(
                    "apply-guard",
                    ["git", "apply", str(FIXTURE / "guard.patch")],
                    SOURCE,
                )
            current = {name: digest(SOURCE / name) for name in native_inputs}
            require(
                current[TESTS] == tests_hash, "Fixture differs across native variants"
            )
            require(
                all(
                    current[name] == value
                    for name, value in native_inputs.items()
                    if name not in (GUARD, TESTS)
                ),
                "Build inputs changed across variants",
            )
            cargo = ["cargo", "+1.95.0"]
            common = [
                "--locked",
                "--release",
                "--target",
                TARGET,
                "-p",
                "codex-windows-sandbox",
            ]
            code, raw = run(
                f"{variant}-native-tests",
                cargo
                + [
                    "test",
                    *common,
                    "--lib",
                    "--",
                    "--exact",
                    "--test-threads=1",
                    "--nocapture",
                    *sorted(expected_tests),
                ],
                SOURCE / "codex-rs",
                build_env,
            )
            result = native_result(raw, expected_tests, variant == "control")
            comparisons[variant] = {"native_inputs": current, "native_tests": result}
            manifest["comparisons"] = comparisons
            save()
            require(
                result["valid"] and code == (101 if variant == "control" else 0),
                f"{variant} native result differs from the bounded expected result",
            )
            checked(
                f"{variant}-build",
                cargo + ["build", *common, "--bin", "codex-windows-sandbox-setup"],
                SOURCE / "codex-rs",
                build_env,
            )
            runtime = stage / variant
            shutil.copytree(package, runtime)
            require(
                tree_hashes(runtime) == original_hashes,
                "Staged official runtime differs",
            )
            command = runtime / command_relative
            helper = command.with_name("codex-windows-sandbox-setup.exe")
            built = build / TARGET / "release/codex-windows-sandbox-setup.exe"
            shutil.copy2(built, helper)
            artifact = REPORTS / f"{variant}-codex-windows-sandbox-setup.exe"
            shutil.copy2(helper, artifact)
            staged_hashes = tree_hashes(runtime)
            expected_hashes = {
                **original_hashes,
                helper.relative_to(runtime).as_posix(): digest(built),
            }
            require(
                staged_hashes == expected_hashes,
                "Staging changed more than the setup helper",
            )
            require(
                command.is_file()
                and not command.is_symlink()
                and helper.is_file()
                and not helper.is_symlink(),
                "Staged executables must be regular files",
            )
            comparisons[variant]["runtime"] = {
                "command": str(command),
                "helper": str(helper),
                "files_before": staged_hashes,
            }
            runner_candidates = [command.with_name("codex-command-runner.exe")]
            if command.parent.name == "bin":
                runner_candidates.append(
                    command.parent.parent / "codex-resources/codex-command-runner.exe"
                )
            runner_candidates.append(
                command.parent / "codex-resources/codex-command-runner.exe"
            )
            runner = next((path for path in runner_candidates if path.is_file()), None)
            require(runner is not None, "Staged package is missing its command runner")
            comparisons[variant]["runtime"]["runner_source"] = str(runner)
            test_env = {**os.environ, "CODEX_CLI_PATH": str(command)}
            report = SDK / f"reports/runner-windows-hook-{variant}.xml"
            code, raw = run(
                f"{variant}-hooks",
                [
                    "node",
                    "--experimental-strip-types",
                    "sdk/typescript/scripts/run-ci-tests.mts",
                    "1/7",
                    "--seed=1",
                    "--test-name-pattern",
                    f"^{HOOK_PREFIX}",
                    f"--reporter-outfile=reports/{report.name}",
                ],
                env=test_env,
            )
            shutil.copy2(report, REPORTS / report.name)
            hooks = hook_result(report, raw, command)
            hooks["returncode"] = code
            comparisons[variant]["hooks"] = hooks
            comparisons[variant]["runtime"]["files_after"] = tree_hashes(runtime)
            require(
                tree_hashes(runtime) == staged_hashes,
                "Staged executables changed during hook cases",
            )
            require(
                tree_hashes(package) == original_hashes,
                "Installed official package changed",
            )
            after = {name: digest(SOURCE / name) for name in native_inputs}
            comparisons[variant]["native_inputs_after"] = after
            require(after == current, "Native source changed during build or tests")
            changed = (
                checked(
                    f"{variant}-source-diff", ["git", "diff", "--name-only"], SOURCE
                )
                .decode()
                .splitlines()
            )
            require(
                set(changed) == ({TESTS} if variant == "control" else {GUARD, TESTS}),
                "Native build changed files outside the reviewed patches",
            )
            save()
        require(
            bool(comparisons["control"]["hooks"]["failed"])
            and set(comparisons["control"]["hooks"]["failed"]) <= {"nested", "standard"}
            and comparisons["control"]["hooks"]["failed"]
            == comparisons["control"]["hooks"]["overwrite_failures"]
            and comparisons["control"]["hooks"]["returncode"] == 1,
            "Control did not reproduce the observed hook failure; comparison is inconclusive",
        )
        require(
            comparisons["candidate"]["hooks"]["failed"] == []
            and comparisons["candidate"]["hooks"]["returncode"] == 0,
            "Candidate did not pass all four original hook assertions",
        )
        manifest["result"] = (
            "bounded comparison passed; not a released fix or PR CI qualification"
        )
    except BaseException as error:
        manifest["error"] = repr(error)
        raise
    finally:
        save()


if __name__ == "__main__":
    main()

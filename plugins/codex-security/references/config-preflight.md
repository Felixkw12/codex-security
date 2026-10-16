# Scan Capability Preflight

Run the read-only helper for top-level Standard and diff scans after resolving authoritative target and scan context, before substantive analysis. Deep scans do not run parent capability preflight. Read `artifact-storage.md` for ownership; an explicitly identified desktop host also uses `desktop-config-preflight.md`.

## Invoke The Helper

Use the configured Python interpreter (`"$PYTHON"` in POSIX shells or `& "$env:PYTHON"` in PowerShell), otherwise `python` on Windows and `python3` on Unix-like hosts:

```text
<python_command> <plugin_dir>/scripts/config_preflight.py --profile <capability-profile> --cwd <scan-working-directory> --runtime-check delegation_available=<true|false> <verified-runtime-arguments>
```

Select `security_scan` or `security_diff_scan`. Inspect the active tools before constructing the command. If delegation tools may be deferred and tool search is available, discover them before reporting `delegation_available=false`. A configured capacity is a maximum, not a count of running workers. When delegation is unavailable or prohibited, report that fact and use the profile's parent fallback without inventing workers or reduced coverage.

For diff, also pass `--runtime-check goal_tools_available=<true|false>`; Standard does not require goal tools. Runtime/config overrides:

- When `CODEX_SECURITY_CONFIG_PATH` is set, pass `--config "$CODEX_SECURITY_CONFIG_PATH"` (PowerShell: `--config "$env:CODEX_SECURITY_CONFIG_PATH"`). This is the CLI's sanitized worker configuration; do not substitute an ambient credential-bearing Codex home.
- Pass a session-selected CLI profile with `--codex-config-profile <name>`. Use `--effective-config <path>=<json-value>` for verified session-only values not recoverable from configuration.
- Otherwise let the helper discover configuration and precedence. For explicitly supplied manual layers, repeated `--config` arguments run from lower to higher precedence.

Run the helper in the parent in Codex CLI so the command and result remain observable. Other hosts may delegate it when useful; pass the runtime facts the worker cannot observe and retain its actual command, exit status, results, configuration path, and remediation. If dispatch fails, run it in the parent. Check command/tool errors before consuming the result; do not reconstruct a missing helper response.

## Runtime Evidence

Supply verified active runtime facts on the first invocation when the session overrides static configuration. Leave runtime arguments out when static configuration fully describes the active mode. Do not infer ownership from an unrelated backend setting.

| Runtime evidence | Arguments |
| --- | --- |
| Exposed `multi_agent_v1` tools | `--multi-agent-runtime-owner native --multi-agent-runtime-version v1 --multi-agent-runtime-provenance tool-surface` |
| Verified native V2 | `--multi-agent-runtime-owner native --multi-agent-runtime-version v2 --multi-agent-session-cap <count> --multi-agent-runtime-provenance <provenance>` |
| Verified bridge ownership | `--multi-agent-runtime-owner codex-bridge --multi-agent-runtime-version v2 --multi-agent-runtime-provenance verified-bridge --effective-config multiagent_config.max_concurrency=<count>` |

For native V2, provenance is `app-server`, `thread-context`, or `tool-surface`, according to the observed source. The V2 cap includes the root. Do not pass a V2 cap for V1, or apply a static default to unknown session-selected capacity. The helper handles capacity requirements, defaults, native-version conflicts, and configuration precedence; use its result rather than interpreting raw config independently. Unknown ownership/capacity blocks only when the profile requires it. Establish missing blocking runtime facts and rerun with the corresponding explicit checks.

## Result And Remediation

Use the helper's overall status and requirements:

- `block`: the requested workflow cannot proceed honestly while unmet.
- `warn`: continue using the documented degraded path.
- `suggest`: mention when material to the requested work; it does not block.

Continue source analysis only after `ready`. An unknown warning or suggestion does not invalidate a ready result. Do not warn merely because a value differs from a suggested configuration patch.

For remediation, present the helper's exact delta and source path. Change only the returned `user_config_path` and concrete patches; never guess the active Codex home or hide a higher-precedence conflict with a lower-precedence edit. Treat `host_setting` patches as host setup guidance, not configuration edits.

In interactive sessions, obtain explicit approval before changing persistent configuration. If approval is needed, offer **Apply and retry**, **Leave paused**, and **Cancel scan**. Use native `request_user_input`, then `request_codex_security_user_input` if unavailable or failing, then chat if that fallback is unavailable or failing. Do not set `autoResolutionMs` or infer a choice from elapsed time, a declined request, or a cancelled input dialog. Preserve the running scan while awaiting the answer; do not create a goal or fail/cancel the scan because an answer is pending. Apply only approved changes and rerun; pause or cancel only at the user's explicit selection.

In non-interactive sessions, never request input. The unattended remediation path may apply only the helper's concrete `value` or `remove` patches to its writable `user_config_path`, preserving unrelated settings; never apply `host_setting` patches. Rerun once with the same verified runtime facts. If still not ready, unavailable, or requiring a new session, report the blocker and preserve the durable scan rather than looping or claiming success.

## Durable Scan Progress

For a host-backed Standard or diff scan, publish each structured result with `update_codex_security_scan_progress` without changing phase. Set `preflightChecks` to the full current `results` array, projecting only `capability`, `reason`, `severity`, and `status`; omit separate phase totals. Publish fresh results on reruns so old issues clear. The server derives counts, and evaluated checks do not imply readiness. After a ready result, advance to `threat_model` in a separate call. Deep owns its own preflight and progress.

Preserve resumable scans when a helper, remediation, or progress operation is blocked. Report the exact reason and recover when possible. Reserve `fail_codex_security_scan` for a confirmed unrecoverable blocker, and `cancel_codex_security_scan` for explicit cancellation. A declined remediation does not by itself mean cancellation.

Before substantive scanning, follow the optional `access-advisory.md` once.

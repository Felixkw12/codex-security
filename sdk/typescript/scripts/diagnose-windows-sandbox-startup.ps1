#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $CodexJs,
    [string] $EvidenceDirectory = (Join-Path $env:RUNNER_TEMP 'codex-sandbox-startup-evidence')
)

# Disposable native diagnostic. Run on an isolated Windows runner with the public
# npm package @openai/codex@0.163.0 installed. No API key or model turn is used.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This diagnostic requires native Windows.' }
$CodexJs = (Resolve-Path -LiteralPath $CodexJs).Path
$manifest = Get-Content (Join-Path (Split-Path (Split-Path $CodexJs)) 'package.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne '0.163.0') { throw 'Expected @openai/codex@0.163.0.' }
$node = (Get-Command node.exe).Source
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$null = New-Item -ItemType Directory -Force -Path $EvidenceDirectory
$EvidenceDirectory = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
$results = [System.Collections.Generic.List[object]]::new()
$fixtures = [System.Collections.Generic.List[object]]::new()
$mutexName = 'Local\CodexSandboxReadAcl'

function Test-ReadWorkerMutex {
    try { $handle = [Threading.Mutex]::OpenExisting($mutexName) }
    catch [Threading.WaitHandleCannotBeOpenedException] { return $false }
    $handle.Dispose()
    return $true
}

function Set-PrivateDirectoryAcl([string] $Path) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
            'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function New-Fixture([string] $Name) {
    if (Test-ReadWorkerMutex) { throw 'An existing read-ACL worker would contaminate the cold fixture.' }
    $root = Join-Path $env:USERPROFILE ('codex-sandbox-267-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $root
    Set-PrivateDirectoryAcl $root
    $f = [pscustomobject]@{
        Name = $Name; Root = $root; Home = (Join-Path $root 'state\codex-home')
        Workspace = (Join-Path $root 'state\scans\workspace'); Temp = (Join-Path $root 'temp')
        Evidence = (Join-Path $EvidenceDirectory $Name); WorkersFinished = $false
    }
    $fixtures.Add($f)
    foreach ($path in @($f.Home, $f.Workspace, $f.Temp, $f.Evidence)) {
        $null = New-Item -ItemType Directory -Force -Path $path
    }
    Set-PrivateDirectoryAcl $f.Home
    Set-PrivateDirectoryAcl $f.Workspace
    Set-Content -LiteralPath (Join-Path $f.Workspace 'probe.txt') -Value 'SYNTHETIC_POLICY_SOURCE' -NoNewline
    # Production Windows policy from scanRuntimeCodexConfig: root/workspace read,
    # credential-home denial, elevated backend, and network disabled. The explicit
    # workspace read keeps the same target readable during the C:\Windows warmup.
    $home = $f.Home.Replace('\', '/')
    $workspace = $f.Workspace.Replace('\', '/')
    $config = @"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
allow_login_shell = false
default_permissions = "codex_security_policy"
[windows]
sandbox = "elevated"
[permissions.codex_security_policy.filesystem]
":root" = "read"
":workspace_roots" = "read"
"$workspace" = { "." = "read" }
"$home" = { "." = "deny" }
[permissions.codex_security_policy.network]
enabled = false
"@
    Set-Content -LiteralPath (Join-Path $f.Home 'config.toml') -Value $config
    Set-Content -LiteralPath (Join-Path $f.Evidence 'config.toml') -Value $config
    return $f
}

function Save-Acls($Fixture, [string] $Phase) {
    @($Fixture.Root, (Split-Path $Fixture.Workspace), $Fixture.Workspace, $Fixture.Home, $Fixture.Temp) |
        ForEach-Object { [pscustomobject]@{ path = $_; sddl = (Get-Acl -LiteralPath $_).Sddl } } |
        ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Fixture.Evidence "$Phase-acls.json")
}

function Read-SandboxLog($Fixture) {
    $files = @(Get-ChildItem -LiteralPath (Join-Path $Fixture.Home '.sandbox') -Filter 'sandbox.*.log' -ErrorAction SilentlyContinue)
    return ($files | Sort-Object Name | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
}

function Read-CompletionCount($Fixture) {
    return [regex]::Matches((Read-SandboxLog $Fixture), '(?m) read ACL run completed\r?$').Count
}

function Wait-NewReadCompletion($Fixture, [int] $Previous) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        if ((Read-CompletionCount $Fixture) -gt $Previous -and -not (Test-ReadWorkerMutex)) {
            $Fixture.WorkersFinished = $true
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "No new completed read-ACL worker for $($Fixture.Name); fixture will be retained."
}

function Invoke-Probe($Fixture, [string] $Phase, [string] $WorkingDirectory) {
    $Fixture.WorkersFinished = $false
    Save-Acls $Fixture "$Phase-before"
    $start = [Diagnostics.ProcessStartInfo]::new($node)
    $start.UseShellExecute = $false
    $start.WorkingDirectory = $env:SystemRoot
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $command = '$ErrorActionPreference = ''Stop''; [Console]::Write((Get-Content -LiteralPath $env:POLICY_PROBE_PATH -Raw))'
    $arguments = @($CodexJs, 'sandbox', '--permission-profile', 'codex_security_policy', '--cd', $WorkingDirectory,
        $powerShell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', $command)
    foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
    foreach ($key in @('OPENAI_API_KEY', 'CODEX_API_KEY')) { $null = $start.Environment.Remove($key) }
    $start.Environment['CODEX_HOME'] = $Fixture.Home
    foreach ($key in @('TEMP', 'TMP', 'TMPDIR')) { $start.Environment[$key] = $Fixture.Temp }
    $start.Environment['POLICY_PROBE_PATH'] = Join-Path $Fixture.Workspace 'probe.txt'
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(120000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "Probe $Phase timed out; fixture will be retained."
    }
    $out = $stdout.GetAwaiter().GetResult()
    $err = $stderr.GetAwaiter().GetResult()
    $row = [pscustomobject]@{ fixture = $Fixture.Name; phase = $Phase; cwd = $WorkingDirectory;
        exitCode = $process.ExitCode; error267 = $err.Contains('CreateProcessWithLogonW failed: 267') }
    $results.Add($row)
    $out | Set-Content (Join-Path $Fixture.Evidence "$Phase-stdout.txt")
    $err | Set-Content (Join-Path $Fixture.Evidence "$Phase-stderr.txt")
    $arguments | ConvertTo-Json | Set-Content (Join-Path $Fixture.Evidence "$Phase-argv.json")
    Save-Acls $Fixture "$Phase-after"
    $row | ConvertTo-Json -Compress | Write-Host
    $process.Dispose()
    return $row
}

try {
    # Unblocked cold control: observe the first launch, then wait for its worker.
    $control = New-Fixture 'unblocked-cold-control'
    $previous = Read-CompletionCount $control
    $null = Invoke-Probe $control 'cold' $control.Workspace
    Wait-NewReadCompletion $control $previous

    # Holding this mutex makes upstream SKIP the read-grant worker. It does not
    # pause an already running worker. Create every fixture before taking it.
    $probe = New-Fixture 'grant-skipped'
    $created = $false
    $mutex = [Threading.Mutex]::new($true, $mutexName, [ref]$created)
    try {
        if (-not $created) { throw 'Another read-ACL worker appeared; refusing a contaminated run.' }
        $skipped = Invoke-Probe $probe 'mutex-present' $probe.Workspace
        (Read-SandboxLog $probe) | Set-Content (Join-Path $probe.Evidence 'mutex-present-sandbox.log')
    } finally {
        if ($created) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }

    # Let a real upstream worker grant the same fixture from an accessible cwd.
    $previous = Read-CompletionCount $probe
    $null = Invoke-Probe $probe 'grant-warmup' $env:SystemRoot
    Wait-NewReadCompletion $probe $previous
    Save-Acls $probe 'grants-complete'
    $previous = Read-CompletionCount $probe
    $retry = Invoke-Probe $probe 'after-grant-retry' $probe.Workspace
    Wait-NewReadCompletion $probe $previous
    if (-not $skipped.error267 -or $retry.exitCode -ne 0) {
        throw 'Expected grant-skipped error 267 followed by successful after-grant retry; inspect the saved evidence.'
    }
} finally {
    $results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $EvidenceDirectory 'results.json')
    foreach ($fixture in $fixtures) {
        (Read-SandboxLog $fixture) | Set-Content (Join-Path $fixture.Evidence 'sandbox.log')
        Save-Acls $fixture 'final'
        if ($fixture.WorkersFinished -and -not (Test-ReadWorkerMutex)) {
            Remove-Item -LiteralPath $fixture.Root -Recurse -Force
        } else {
            Write-Warning "Retained synthetic fixture because worker completion is unconfirmed: $($fixture.Root)"
        }
    }
}

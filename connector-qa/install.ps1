<#
.SYNOPSIS
    Installs the connector-qa skill into Claude Code and points it at an output folder.

.DESCRIPTION
    Copies the runtime part of this folder to ~/.claude/skills/connector-qa/ and writes the
    machine-specific output root into the INSTALLED config.json. The shared copy in this folder
    always keeps `root` empty, so no username ever ends up in a file you hand to someone else.

    Only the runtime is installed: SKILL.md, config.json, LICENSE.txt, agents, assets,
    references, schemas and scripts. Documents, tests, evals, node_modules and `_`-prefixed
    scratch files stay here.

    Works in Windows PowerShell 5.1 and PowerShell 7+. Re-run any time to push edits from this
    folder to the installed copy. It is idempotent.

.PARAMETER Root
    Where test artifacts and reports are written. Defaults to this folder's parent, so an
    unzip to <anywhere>\ConnectAIMCPTest\connector-qa\ needs no configuration at all.

.PARAMETER Link
    Install as a directory junction instead of a copy, so edits here take effect immediately
    with no re-run. Works without administrator rights. Avoid it when this folder lives in a
    cloud-synced tree that may dehydrate files (OneDrive Files On-Demand) - a dehydrated skill
    folder cannot be loaded.

.PARAMETER Uninstall
    Remove the installed skill. Never touches this folder or any test output.

.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -Root "D:\QA\ConnectAIMCPTest"
.EXAMPLE
    .\install.ps1 -Link
#>
[CmdletBinding()]
param(
    [string] $Root,
    [switch] $Link,
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$SkillName  = 'connector-qa'
$Source     = $PSScriptRoot
$Target     = Join-Path $HOME ".claude\skills\$SkillName"
$NodeMajor  = 20
# The runtime skill. Everything else in this folder is for the people who maintain it.
$Runtime    = 'SKILL.md', 'config.json', 'LICENSE.txt', 'agents', 'assets', 'references', 'schemas', 'scripts'
# Development tools that live under scripts/ but have no job in an installed skill
$DevOnly    = 'scripts\sync-skill.mjs'
# PowerShell 5.1's "-Encoding UTF8" writes a byte-order mark, which JSON.parse in Node rejects
$Utf8NoBom  = New-Object System.Text.UTF8Encoding $false

function Say  ($m) { Write-Host "  $m" }
function Good ($m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Bad  ($m) { Write-Host "  [fail] $m" -ForegroundColor Red }

Write-Host "`nconnector-qa installer`n" -ForegroundColor Cyan

# ── uninstall ────────────────────────────────────────────────────────────────
if ($Uninstall) {
    if (Test-Path -LiteralPath $Target) {
        # a junction must be removed without recursing into the real folder
        $item = Get-Item -LiteralPath $Target -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            [IO.Directory]::Delete($Target, $false)
        } else {
            Remove-Item -LiteralPath $Target -Recurse -Force
        }
        Good "removed $Target"
    } else { Say "nothing installed at $Target" }
    [Environment]::SetEnvironmentVariable('CONNECTOR_QA_ROOT', $null, 'User')
    Good "cleared CONNECTOR_QA_ROOT"
    Say  "your project folder and all test output were left untouched."
    Write-Host ""
    return
}

# ── sanity: are we in a real skill folder? ───────────────────────────────────
foreach ($required in $Runtime) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $required))) {
        Bad "missing '$required' - run this from inside the skill folder."
        exit 1
    }
}
Good "source looks complete: $Source"

# ── prerequisites, checked before anything is changed ────────────────────────
# Node is not optional: gap arithmetic, coverage crediting and report building are Node scripts.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Bad "node not found on PATH."
    Say "the skill's deterministic half (gaps, crediting, reports) is Node scripts."
    Say "install Node $NodeMajor LTS or newer from https://nodejs.org, open a new terminal, and re-run."
    exit 1
}
$v = (& node --version) -replace '^v', ''
if ([int]($v -split '\.')[0] -lt $NodeMajor) {
    Bad "node $v is too old - the scripts need Node $NodeMajor or newer."
    exit 1
}
Good "node $v"

# ── resolve the output root ──────────────────────────────────────────────────
if (-not $Root) { $Root = Split-Path -Parent $Source }
try {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $Root = (Resolve-Path -LiteralPath $Root).Path
} catch {
    Bad "cannot create output root: $Root"
    Say "pass a writable path, e.g.  .\install.ps1 -Root `"D:\QA\ConnectAIMCPTest`""
    exit 1
}

$probe = Join-Path $Root ".writetest"
try { Set-Content -LiteralPath $probe -Value 'x'; Remove-Item -LiteralPath $probe -Force }
catch { Bad "output root is not writable: $Root"; exit 1 }
Good "output root: $Root"

New-Item -ItemType Directory -Force -Path (Join-Path $Root '_querydumps') | Out-Null
Say "shared dump folder ready: $(Join-Path $Root '_querydumps')"

# ── install ──────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null

if (Test-Path -LiteralPath $Target) {
    $existing = Get-Item -LiteralPath $Target -Force
    if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [IO.Directory]::Delete($Target, $false); Say "replaced existing junction"
    } else {
        Remove-Item -LiteralPath $Target -Recurse -Force; Say "replaced existing copy"
    }
}

if ($Link) {
    try {
        New-Item -ItemType Junction -Path $Target -Target $Source -ErrorAction Stop | Out-Null
        Good "linked  $Target  ->  $Source"
        Warn "config.root stays empty in a linked install; CONNECTOR_QA_ROOT is what points at your output folder."
    } catch {
        Bad "junction failed: $($_.Exception.Message)"
        Say "re-run without -Link to install as a copy."
        exit 1
    }
} else {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    foreach ($item in $Runtime) {
        Copy-Item -LiteralPath (Join-Path $Source $item) -Destination $Target -Recurse -Force
    }
    foreach ($dev in $DevOnly) {
        $p = Join-Path $Target $dev
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }

    # Bake the resolved root into the INSTALLED config only - never the source. The value is
    # spliced into the original text rather than re-serialised, so the file keeps its layout and
    # 5.1's ConvertTo-Json never gets a chance to rewrite it.
    $cfgPath = Join-Path $Target 'config.json'
    $text    = [IO.File]::ReadAllText($cfgPath)
    $quoted  = ConvertTo-Json -InputObject ([string]$Root) -Compress
    $rx      = [regex]'(?m)^(  "root":\s*)""'
    if ($rx.IsMatch($text)) {
        $text = $rx.Replace($text, { param($m) $m.Groups[1].Value + $quoted }, 1)
    } else {
        $cfg = $text | ConvertFrom-Json
        $cfg.root = $Root
        $text = $cfg | ConvertTo-Json -Depth 20
    }
    [IO.File]::WriteAllText($cfgPath, $text, $Utf8NoBom)
    if ((([IO.File]::ReadAllText($cfgPath)) | ConvertFrom-Json).root -ne $Root) {
        Bad "could not write config.root into $cfgPath"
        exit 1
    }
    Good "installed to $Target"
    Good "installed config.root set to your output folder"

    # Remember where this copy came from, so every run can notice when the source has moved on
    # (scripts/check-version.mjs). A linked install IS the source and needs no record.
    $srcVersion = ((([IO.File]::ReadAllText((Join-Path $Source 'config.json'))) | ConvertFrom-Json).version)
    $info = [ordered]@{ source = $Source; version = $srcVersion; installed_at = (Get-Date).ToUniversalTime().ToString('o') }
    [IO.File]::WriteAllText((Join-Path $Target 'install-info.json'), ($info | ConvertTo-Json), $Utf8NoBom)
    Good "installed version $srcVersion (source recorded for the version check)"
    & node (Join-Path $Target 'scripts\check-version.mjs') --stamp $Source | Out-Host
}

# ── machine-specific env var (survives a -Link install too) ──────────────────
[Environment]::SetEnvironmentVariable('CONNECTOR_QA_ROOT', $Root, 'User')
$env:CONNECTOR_QA_ROOT = $Root
Good "CONNECTOR_QA_ROOT set for your user account"

# ── integrity checks ─────────────────────────────────────────────────────────
$failed = $false

$tpl = Join-Path $Target 'assets\report-template.html'
if ((Test-Path -LiteralPath $tpl) -and (Get-Item -LiteralPath $tpl).Length -gt 50000) { Good "report template present" }
else { Bad "report template missing or truncated"; $failed = $true }
foreach ($t in @('capability-report-template.html', 'eval-report-template.html')) {
  $p = Join-Path $Target "assets\$t"
  if ((Test-Path -LiteralPath $p) -and (Get-Item -LiteralPath $p).Length -gt 20000) { Good "$t present" }
  else { Bad "$t missing or truncated"; $failed = $true }
}

$refs = @(Get-ChildItem -LiteralPath (Join-Path $Target 'references') -Filter *.md).Count
if ($refs -ge 11) { Good "$refs reference files" } else { Bad "expected 11+ reference files, found $refs"; $failed = $true }

$agents = @(Get-ChildItem -LiteralPath (Join-Path $Target 'agents') -Filter *.md -ErrorAction SilentlyContinue).Count
if ($agents -ge 4) { Good "$agents research agents" } else { Bad "expected 4 agent definitions, found $agents"; $failed = $true }

$scripts = @(Get-ChildItem -LiteralPath (Join-Path $Target 'scripts') -Filter *.mjs -ErrorAction SilentlyContinue).Count
if ($scripts -ge 12) { Good "$scripts scripts (gap arithmetic, crediting, report build are code, not prose)" }
else { Bad "expected 12+ scripts, found $scripts"; $failed = $true }

$chk = & node (Join-Path $Target 'scripts\check-skill.mjs') $Target 2>&1
if ($LASTEXITCODE -eq 0) { Good "check-skill: references resolve, scripts parse, config valid" }
else { Bad "check-skill reported problems:"; $chk | Select-Object -Last 8 | ForEach-Object { Say "    $_" }; $failed = $true }

if ($failed) {
    Write-Host "`n  NOT ready - fix the [fail] lines above and re-run.`n" -ForegroundColor Red
    exit 1
}

# ── done ─────────────────────────────────────────────────────────────────────
Write-Host "`n  Ready.`n" -ForegroundColor Cyan
Say "Start a NEW Claude Code session, then run:"
Write-Host "      /connector-qa <ConnectorName>" -ForegroundColor White
Say ""
Say "Reports land in  $Root\<ConnectorName>\"
Say "Drop customer query dumps (.csv) in  $Root\_querydumps\  to enrich coverage."
if (-not $Link) { Say "Edited the skill? Re-run this script to push changes to the installed copy." }
Write-Host ""

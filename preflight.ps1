# preflight.ps1 - ensure toolchain + self-heal config.json (PROCESS+PREFLIGHT specialist).
#
# Required CLIs: node, git, claude, mimo.   Optional: gemini (only with -WithGemini).
# Auto-installs missing claude/mimo via npm -g (user pre-approved; prints a notice).
# Then rewrites config.json bins{claude,mimo,gemini,git} + nodeBin with resolved absolute paths.
#
# Flags:
#   -Update        force `npm install -g` (upgrade) for claude + mimo (+gemini if -WithGemini)
#   -WithGemini    also require/resolve gemini
#   -SkipSetup     resolve + self-heal config ONLY; never install (used by run.ps1 fast path)
#
# Exit codes: 0 = all required present & config healed; 3 = node absent;
#             4 = a REQUIRED cli (git/claude/mimo) absent and could not be installed.
#
# Windows PowerShell 5.1: no ternary, no '??', no '&&'. NO-BOM config write via UTF8Encoding($false).

[CmdletBinding()]
param(
  [switch]$Update,
  [switch]$WithGemini,
  [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'config.json'

function Info($m)  { Write-Host "[preflight] $m" }
function Warn($m)  { Write-Host "[preflight] WARN: $m" -ForegroundColor Yellow }
function Fail($m)  { Write-Host "[preflight] ERROR: $m" -ForegroundColor Red }

# Resolve a command's absolute path. Returns $null if not found.
# Get-Command on Windows returns .Source for native exes/cmd shims.
function Resolve-Cli([string]$name) {
  $found = $null
  try {
    $c = Get-Command $name -ErrorAction Stop | Select-Object -First 1
    if ($c.Source) { $found = $c.Source } elseif ($c.Path) { $found = $c.Path }
  } catch {}
  if ($found) {
    # orchestrate.mjs runCli can spawn .exe (direct) and .cmd/.bat (via cmd.exe), but NOT .ps1.
    # If Get-Command resolved to a .ps1 shim, prefer its .cmd/.exe sibling.
    if ($found -match '\.ps1$') {
      foreach ($ext in @('.cmd', '.exe')) {
        $sib = [System.IO.Path]::ChangeExtension($found, $ext)
        if (Test-Path $sib) { return $sib }
      }
    }
    return $found
  }
  # Fallback: npm global bin dir is often NOT on PATH for headless shells.
  foreach ($ext in @('.cmd', '.exe', '')) {
    $cand = Join-Path $env:APPDATA "npm\$name$ext"
    if ($cand -and (Test-Path $cand)) { return $cand }
  }
  return $null
}

function Get-ConfigSafe {
  if (-not (Test-Path $configPath)) { return $null }
  try { return Get-Content $configPath -Raw | ConvertFrom-Json } catch { return $null }
}

# Sortable key from a version-ish dir name ("2.1.170" -> comparable). Non-numeric -> 0.
function Parse-VersionKey([string]$name) {
  $parts = ($name -split '[^\d]+') | Where-Object { $_ -ne '' }
  $v = 0L
  foreach ($seg in ($parts | Select-Object -First 4)) {
    $n = 0L; [void][int64]::TryParse($seg, [ref]$n)
    $v = ($v * 100000L) + [int64]$n
  }
  return $v
}

# ---------------------------------------------------------------------------
# NODE - fix BUG 1. Probe order: (a) PATH, (b) config.nodeBin\node.exe, (c) Program Files.
# ---------------------------------------------------------------------------
function Resolve-Node {
  $p = Resolve-Cli 'node'
  if ($p) { return $p }
  $cfg = Get-ConfigSafe
  if ($cfg -and $cfg.nodeBin) {
    $cand = Join-Path $cfg.nodeBin 'node.exe'
    if (Test-Path $cand) { return $cand }
  }
  $fallback = 'C:\Program Files\nodejs\node.exe'
  if (Test-Path $fallback) { return $fallback }
  return $null
}

# ---------------------------------------------------------------------------
# CLAUDE - fix BUG 2. Version-pinned path rots on update. Resolution order:
#   1. PATH `claude` (ground truth: claude resolves on PATH without injection)
#   2. existing config path IF it still exists on disk
#   3. glob the packaged install ...\claude-code\*\claude.exe -> highest version dir
# ---------------------------------------------------------------------------
function Resolve-Claude {
  $p = Resolve-Cli 'claude'
  if ($p) { return $p }

  $cfg = Get-ConfigSafe
  if ($cfg -and $cfg.bins -and $cfg.bins.claude -and (Test-Path $cfg.bins.claude)) {
    return $cfg.bins.claude
  }

  $root = Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code'
  if (Test-Path $root) {
    $exe = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
      Sort-Object { Parse-VersionKey $_.Name } -Descending |
      ForEach-Object { Join-Path $_.FullName 'claude.exe' } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($exe) { return $exe }
  }
  return $null
}

# Install/upgrade a global npm package, then re-resolve the produced cli.
function Ensure-NpmCli {
  param([string]$cliName, [string]$pkg, [string]$nodeDir, [switch]$ForceUpdate, [switch]$Required)

  $resolved = Resolve-Cli $cliName
  if ($resolved -and -not $ForceUpdate) { return $resolved }
  if ($SkipSetup) {
    if ($Required -and -not $resolved) { Fail "$cliName not found and -SkipSetup set (no install)." }
    return $resolved
  }

  $npm = Join-Path $nodeDir 'npm.cmd'
  if (-not (Test-Path $npm)) { $npm = 'npm.cmd' } # fall back to PATH

  $action = 'Installing'
  if ($resolved) { $action = 'Updating' }
  Info "$action $cliName via: $npm install -g $pkg  (user-approved auto-install)"
  try {
    & $npm install -g $pkg
    if ($LASTEXITCODE -ne 0) { throw "npm exited $LASTEXITCODE" }
  } catch {
    Warn "npm install of $pkg failed: $_"
  }
  return (Resolve-Cli $cliName)
}

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
$failed = $false

# 1) NODE (required, never auto-installed - bootstrap dependency)
$nodePath = Resolve-Node
if (-not $nodePath) {
  Fail "Node.js not found. Install it (https://nodejs.org, LTS) or place it at 'C:\Program Files\nodejs', then re-run."
  exit 3
}
$nodeDir = Split-Path -Parent $nodePath
Info "node  -> $nodePath"

# 2) GIT (required, not auto-installed)
$gitPath = Resolve-Cli 'git'
if (-not $gitPath -and (Test-Path 'C:\Program Files\Git\cmd\git.exe')) { $gitPath = 'C:\Program Files\Git\cmd\git.exe' }
if (-not $gitPath) { Fail "git not found. Install Git for Windows (https://git-scm.com), then re-run."; $failed = $true }
else { Info "git   -> $gitPath" }

# 3) CLAUDE (required, auto-install @anthropic-ai/claude-code if missing)
$claudePath = Resolve-Claude
if (-not $claudePath -or $Update) {
  $claudePath = Ensure-NpmCli -cliName 'claude' -pkg '@anthropic-ai/claude-code' -nodeDir $nodeDir -ForceUpdate:$Update -Required
  if (-not $claudePath) { $claudePath = Resolve-Claude } # packaged install may exist even if npm one doesn't
}
if (-not $claudePath) { Fail "claude CLI unavailable and could not be installed."; $failed = $true }
else { Info "claude-> $claudePath" }

# 4) MIMO (required, auto-install @mimo-ai/cli if missing)
$mimoPath = Resolve-Cli 'mimo'
if (-not $mimoPath -or $Update) {
  $mimoPath = Ensure-NpmCli -cliName 'mimo' -pkg '@mimo-ai/cli' -nodeDir $nodeDir -ForceUpdate:$Update -Required
}
if (-not $mimoPath) { Fail "mimo CLI unavailable and could not be installed."; $failed = $true }
else { Info "mimo  -> $mimoPath" }

# 5) GEMINI (optional - only when -WithGemini)
$geminiPath = Resolve-Cli 'gemini'
if ($WithGemini) {
  if (-not $geminiPath -or $Update) {
    $geminiPath = Ensure-NpmCli -cliName 'gemini' -pkg '@google/gemini-cli' -nodeDir $nodeDir -ForceUpdate:$Update
  }
  if (-not $geminiPath) { Warn "gemini requested (-WithGemini) but unavailable; --executor gemini will fail." }
  else { Info "gemini-> $geminiPath" }
} elseif ($geminiPath) {
  Info "gemini-> $geminiPath (optional, present)"
}

# ---------------------------------------------------------------------------
# SELF-HEAL config.json - write resolved absolute paths back (BUG 1 + BUG 2 fixed).
# Preserves all other keys via PSCustomObject round-trip. NO-BOM UTF-8 write so
# Node's JSON.parse reads it clean.
# ---------------------------------------------------------------------------
if (Test-Path $configPath) {
  try {
    # Add-or-set a property safely: ConvertFrom-Json PSCustomObjects throw on dot-assigning a
    # property that does not already exist, so create it via Add-Member when absent.
    function Set-Prop($obj, $name, $val) {
      if ($obj.PSObject.Properties[$name]) { $obj.$name = $val }
      else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $val }
    }
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json

    Set-Prop $cfg 'nodeBin' $nodeDir
    if (-not $cfg.PSObject.Properties['bins']) { Set-Prop $cfg 'bins' ([pscustomobject]@{}) }
    if ($claudePath) { Set-Prop $cfg.bins 'claude' $claudePath }
    if ($mimoPath)   { Set-Prop $cfg.bins 'mimo'   $mimoPath }
    if ($gitPath)    { Set-Prop $cfg.bins 'git'    $gitPath }
    if ($geminiPath) { Set-Prop $cfg.bins 'gemini' $geminiPath }

    $json = ($cfg | ConvertTo-Json -Depth 12)
    [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Info "config.json self-healed (nodeBin + bins updated)."
  } catch {
    Warn "could not self-heal config.json: $_"
  }
} else {
  Warn "config.json not found at $configPath - skipping self-heal."
}

# ---------------------------------------------------------------------------
# AUTH STATUS HINTS (non-blocking - informational)
# ---------------------------------------------------------------------------
Write-Host ""
Info "Auth hints:"
Write-Host "  claude : uses your Claude desktop session credentials (run 'claude' once interactively if unauthenticated)."
Write-Host "  mimo   : if calls 401, run 'mimo providers login -p mimo'."
$envLocal = Join-Path $PSScriptRoot '.env.local'
if ($WithGemini -or $geminiPath) {
  $hasKey = (Test-Path $envLocal) -and ((Get-Content $envLocal -Raw) -match 'GEMINI_API_KEY\s*=\s*\S')
  if ($hasKey) { Write-Host "  gemini : GEMINI_API_KEY found in .env.local." }
  else         { Write-Host "  gemini : add GEMINI_API_KEY=... to $envLocal (gitignored)." }
}
Write-Host ""

if ($failed) { Fail "one or more REQUIRED clis are missing. See messages above."; exit 4 }
Info "preflight OK."
exit 0

# run.ps1 - launcher for the Opus-orchestrated coding pipeline (v2).
#
# Fixes v1 BUG 1: no hardcoded node path. Detects node+git, prepends their dirs to PATH,
# loads .env.local, runs preflight (self-heals config.json), then runs orchestrate.mjs.
#
# Examples:
#   .\run.ps1 "Add a /health endpoint returning {status:'ok'}"
#   .\run.ps1 --task-file .\task.md --dir ..\some-repo --max-iters 5 --verify "npm test"
#   .\run.ps1 --dry-run "Refactor the date utils"
#   .\run.ps1 -WithGemini --executor gemini "..."   # PS flags before the passthrough args
#   .\run.ps1 -SkipSetup "..."                        # skip preflight install (fast)
#   .\run.ps1 -Update "..."                           # force-upgrade claude/mimo first
#
# NOTE: PowerShell flags (-WithGemini/-SkipSetup/-Update) must come BEFORE the orchestrate args.
# Everything PowerShell doesn't recognize is forwarded verbatim to orchestrate.mjs via $Rest.
#
# Windows PowerShell 5.1: no ternary, no '??', no '&&'.

[CmdletBinding()]
param(
  [switch]$SkipSetup,
  [switch]$WithGemini,
  [switch]$Update,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# --- Capture the CALLER's cwd so orchestrate.mjs --dir defaults correctly ---
$callerCwd = (Get-Location).Path

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

# --- 1) Detect node (PATH -> config.nodeBin -> Program Files). NO hardcoded tools path (BUG 1). ---
$nodePath = Resolve-Cli 'node'
if (-not $nodePath) {
  $cfgPath = Join-Path $PSScriptRoot 'config.json'
  if (Test-Path $cfgPath) {
    try {
      $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
      if ($cfg.nodeBin -and (Test-Path (Join-Path $cfg.nodeBin 'node.exe'))) {
        $nodePath = Join-Path $cfg.nodeBin 'node.exe'
      }
    } catch {}
  }
}
if (-not $nodePath -and (Test-Path 'C:\Program Files\nodejs\node.exe')) {
  $nodePath = 'C:\Program Files\nodejs\node.exe'
}
if (-not $nodePath) {
  Write-Host "[run] ERROR: Node.js not found. Install LTS from https://nodejs.org and re-run." -ForegroundColor Red
  exit 3
}
$nodeDir = Split-Path -Parent $nodePath

# --- 2) Detect git ---
$gitPath = Resolve-Cli 'git'
if (-not $gitPath -and (Test-Path 'C:\Program Files\Git\cmd\git.exe')) { $gitPath = 'C:\Program Files\Git\cmd\git.exe' }
$gitDir = $null
if ($gitPath) { $gitDir = Split-Path -Parent $gitPath }

# --- 3) PATH: prepend resolved node + git + npm-global dirs (dupes are harmless) ---
$npmDir = Join-Path $env:APPDATA 'npm'
$prepend = $nodeDir
if ($gitDir) { $prepend = "$prepend;$gitDir" }
if (Test-Path $npmDir) { $prepend = "$prepend;$npmDir" }
$env:Path = "$prepend;" + $env:Path

# --- 4) Load .env.local secrets (GEMINI_API_KEY, etc.) into PROCESS env ---
$envFile = Join-Path $PSScriptRoot '.env.local'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*)$') {
      $val = $matches[2].Trim().Trim('"').Trim("'")
      [Environment]::SetEnvironmentVariable($matches[1].Trim(), $val, 'Process')
    }
  }
}

# --- 5) Preflight (resolve clis + self-heal config.json) ---
$preflight = Join-Path $PSScriptRoot 'preflight.ps1'
if (-not $SkipSetup -and (Test-Path $preflight)) {
  $pfArgs = @{}
  if ($WithGemini) { $pfArgs['WithGemini'] = $true }
  if ($Update)     { $pfArgs['Update']     = $true }
  & $preflight @pfArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[run] preflight failed (exit $LASTEXITCODE). Aborting." -ForegroundColor Red
    exit $LASTEXITCODE
  }
} elseif ($SkipSetup -and (Test-Path $preflight)) {
  & $preflight -SkipSetup   # resolve + heal config without installing
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[run] preflight failed (exit $LASTEXITCODE). Aborting." -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

# --- 6) Forward to orchestrate.mjs. Inject --dir <callerCwd> if the user didn't pass one. ---
$script = Join-Path $PSScriptRoot 'orchestrate.mjs'
$passArgs = @()
if ($Rest) { $passArgs += $Rest }
if (-not ($passArgs -contains '--dir')) {
  $passArgs += @('--dir', $callerCwd)
}

# Use the resolved node binary directly (not the broken hardcoded path).
& $nodePath $script @passArgs
exit $LASTEXITCODE

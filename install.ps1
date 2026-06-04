# install.ps1 — Hermes Zalo bridge installer for Windows (PowerShell).
# Thin wrapper: verifies Node is present, then hands off to install.mjs.
#
#   .\install.ps1                # full setup
#   .\install.ps1 --no-service   # skip the auto-start scheduled task
#   .\install.ps1 --relogin      # force a fresh QR login
#
# If you get an execution-policy error, run once:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Dir

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "X Node.js is required but not found." -ForegroundColor Red
  Write-Host "  Install Node >= 18 from https://nodejs.org, then re-run."
  exit 1
}

& node install.mjs @args
exit $LASTEXITCODE

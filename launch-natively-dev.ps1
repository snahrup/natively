param(
  [switch]$Show = $true,
  [switch]$NoShow,
  [switch]$ChatLogViewer,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  throw "npm.cmd was not found on PATH. Install Node.js or open a shell with npm available."
}

$appArgs = @()
if ($Show -and -not $NoShow) {
  $appArgs += "--show"
}
if ($ChatLogViewer) {
  $appArgs += "--chat-log-viewer"
}
if ($ExtraArgs) {
  $appArgs += $ExtraArgs
}

$argumentList = @("run", "app:dev")
if ($appArgs.Count -gt 0) {
  $argumentList += "--"
  $argumentList += $appArgs
}

Start-Process -FilePath $npmCmd.Source -ArgumentList $argumentList -WorkingDirectory $repoRoot -WindowStyle Normal | Out-Null

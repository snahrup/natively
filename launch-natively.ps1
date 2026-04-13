param(
    [switch]$Show = $true
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$releaseRoot = Join-Path $repoRoot "release"

if (!(Test-Path $releaseRoot)) {
  throw "No release folder found at $releaseRoot"
}

function Resolve-VersionNumber([string]$fileName) {
  $match = [regex]::Match($fileName, 'Natively\s+(\d+\.\d+\.\d+)')
  if (!$match.Success) {
    return [version]"0.0.0"
  }
  return [version]$match.Groups[1].Value
}

function Resolve-LatestExecutable() {
  $directCandidates = Get-ChildItem -Path $releaseRoot -Filter "Natively *.exe" -File |
    Where-Object { $_.Name -notlike "Natively-Setup*" } |
    Where-Object { $_.Name -notlike "*portable*" } |
    Sort-Object { Resolve-VersionNumber $_.Name } |
    Select-Object -Last 1

  if ($directCandidates) {
    return $directCandidates.FullName
  }

  $portableCandidates = Get-ChildItem -Path $releaseRoot -File -Recurse -Filter "Natively.exe" |
    Where-Object { $_.DirectoryName -like "*win-unpacked*" -or $_.DirectoryName -like "*win-ia32-unpacked*" } |
    Select-Object -Last 1

  if ($portableCandidates) {
    return $portableCandidates.FullName
  }

  return $null
}

$exePath = $null

$candidate = Resolve-LatestExecutable
if ($candidate) {
  $exePath = $candidate
}

if (-not $exePath) {
  throw "No Natively executable found under $releaseRoot"
}

$alreadyRunning = Get-Process -Name "Natively" -ErrorAction SilentlyContinue | Where-Object {
  $path = $null
  try {
    $path = $_.Path
  } catch {
    $path = $null
  }
  return $path -and (Resolve-Path -LiteralPath $path).Path -ieq (Resolve-Path -LiteralPath $exePath).Path
}

$arguments = @()
if ($Show) {
  $arguments += '--show'
}

if ($alreadyRunning) {
  Start-Process -FilePath $exePath -ArgumentList $arguments -WindowStyle Normal | Out-Null
} else {
  Start-Process -FilePath $exePath -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Normal | Out-Null
}

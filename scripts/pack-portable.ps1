$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceElectron = Join-Path $root 'node_modules\electron\dist'
$releaseRoot = Join-Path $root 'release'
$target = Join-Path $releaseRoot 'GPT Image Tools Portable'
$appDir = Join-Path $target 'resources\app'

if (-not (Test-Path -LiteralPath (Join-Path $sourceElectron 'electron.exe'))) {
  throw "Electron runtime was not found at $sourceElectron. Run npm install first."
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

$resolvedReleaseRoot = (Resolve-Path $releaseRoot).Path
if ((Split-Path -Parent $target) -ne $resolvedReleaseRoot) {
  throw "Unexpected portable target path: $target"
}

if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

New-Item -ItemType Directory -Path $target -Force | Out-Null

Get-ChildItem -LiteralPath $sourceElectron | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
}

$electronExe = Join-Path $target 'electron.exe'
Rename-Item -LiteralPath $electronExe -NewName 'GPT Image Tools.exe' -Force

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination $appDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root 'dist-electron') -Destination $appDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root 'electron\preload.cjs') -Destination (Join-Path $appDir 'dist-electron\preload.cjs') -Force
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $root 'node_modules') -Destination $appDir -Recurse -Force

Write-Host "Portable app created: $target"

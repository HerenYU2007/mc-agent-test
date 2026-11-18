[CmdletBinding()]
param(
    [string]$ServerDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'server261-fresh')
)

$ErrorActionPreference = 'Stop'
$server = (Resolve-Path -LiteralPath $ServerDirectory).Path
$properties = Join-Path $server 'server.properties'
$level = Select-String -LiteralPath $properties -Pattern '^level-name=(.+)$' | Select-Object -Last 1
$world = if ($level) { $level.Matches[0].Groups[1].Value.Trim() } else { 'world' }
$worldPath = Join-Path $server $world
if (-not (Test-Path -LiteralPath $worldPath -PathType Container)) {
    throw "未找到世界目录 $worldPath"
}

$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'datapacks/nmo-telemetry'
$destination = Join-Path $worldPath 'datapacks/nmo-telemetry'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($entry in Get-ChildItem -LiteralPath $source) {
    Copy-Item -LiteralPath $entry.FullName -Destination $destination -Recurse -Force
}
Write-Output $destination

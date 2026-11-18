$ErrorActionPreference = 'Stop'
$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverTarget = if (Test-Path (Join-Path $serverDir 'server261-fresh\server.jar')) { 'server261-fresh' } else { 'server' }
$serverJar = Join-Path $serverDir "$serverTarget\server.jar"
$eulaFile = Join-Path $serverDir "$serverTarget\eula.txt"
$appData = if ($env:APPDATA) { $env:APPDATA } else { "$env:USERPROFILE\AppData\Roaming" }
$minecraftJava25 = "$appData\.minecraft\runtime\java-runtime-epsilon\bin\java.exe"
$java = if (Test-Path $minecraftJava25) { $minecraftJava25 } elseif ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\java.exe")) { "$env:JAVA_HOME\bin\java.exe" } else { 'java' }

if (!(Test-Path $serverJar)) {
  throw "Missing server.jar: $serverJar"
}

if (!(Test-Path $eulaFile)) {
  Write-Host 'Minecraft server has not been initialized yet.'
  Write-Host "Run this script once to create eula.txt, then review the Minecraft EULA and set eula=true yourself if you accept it."
  Push-Location (Join-Path $serverDir $serverTarget)
  try {
    & $java -jar $serverJar nogui
  } finally {
    Pop-Location
  }
  exit $LASTEXITCODE
}

$eula = Get-Content $eulaFile -Raw
if ($eula -notmatch '(?m)^eula=true\s*$') {
  throw "The local server will not start until you review the EULA and set eula=true in $eulaFile."
}

Push-Location (Join-Path $serverDir $serverTarget)
try {
  & $java -Xms1G -Xmx2G -jar $serverJar nogui
} finally {
  Pop-Location
}

$ErrorActionPreference = 'Stop'
$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverTarget = 'server12111-fresh'
$serverJar = Join-Path $serverDir "$serverTarget\server.jar"
$eulaFile = Join-Path $serverDir "$serverTarget\eula.txt"
$appData = if ($env:APPDATA) { $env:APPDATA } else { "$env:USERPROFILE\AppData\Roaming" }
$minecraftJava21 = "$appData\.minecraft\runtime\java-runtime-delta\bin\java.exe"
$java = if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\java.exe")) { "$env:JAVA_HOME\bin\java.exe" } elseif (Test-Path $minecraftJava21) { $minecraftJava21 } else { 'java' }

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

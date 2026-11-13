# Start de server op deze pc. Bij de eerste keer maak je een account aan (gebruikersnaam en wachtwoord);
# dat account is beheerder en kan in de app andere accounts aanmaken.
#
# Gebruik (in PowerShell, vanuit de map tickory):   .\start.cmd
# Optioneel:  -Port 8787   -BindHost 127.0.0.1

param(
  [int]$Port = 8787,
  [string]$BindHost = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$users = node server/main.ts user list
if ($LASTEXITCODE -ne 0) { throw 'De server kon niet starten (is Node 26 geinstalleerd?).' }
if (-not $users) {
  Write-Host ''
  Write-Host 'Eerste start: maak je account aan. Het wachtwoord heeft minimaal 10 tekens en is tijdens het typen niet te zien.'
  $name = Read-Host 'Gebruikersnaam'
  node server/main.ts user add $name --admin
  if ($LASTEXITCODE -ne 0) { throw 'Het account is niet aangemaakt. Start opnieuw om het nog eens te proberen.' }
}

$env:PORT = "$Port"
$env:HOST = $BindHost
Write-Host ''
Write-Host "Open in je browser:  http://${BindHost}:$Port"
Write-Host ''
node server/main.ts

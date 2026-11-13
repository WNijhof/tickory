# Start de server. Bij de eerste keer wordt een token aangemaakt en in data\token.txt bewaard,
# zodat je daarna altijd hetzelfde token hebt. Het token wordt getoond, want je vult het in de app in.
#
# Gebruik (in PowerShell, vanuit de map eigen-tool):   .\scripts\start.ps1
# Optioneel:  -Port 8787   -BindHost 127.0.0.1   -TokenFile <pad>

param(
  [int]$Port = 8787,
  [string]$BindHost = '127.0.0.1',
  [string]$TokenFile = ''
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not $TokenFile) { $TokenFile = Join-Path (Get-Location) 'data\token.txt' }
New-Item -ItemType Directory -Force (Split-Path -Parent $TokenFile) | Out-Null

if (-not (Test-Path -LiteralPath $TokenFile)) {
  $new = (node server/main.ts --new-token | Select-Object -First 1).Trim()
  if ($new.Length -lt 24) { throw 'Het token kon niet worden aangemaakt (is Node 26 geinstalleerd?).' }
  Set-Content -LiteralPath $TokenFile -Value $new -Encoding ascii
  Write-Host "Nieuw token aangemaakt en bewaard in $TokenFile"
}

$env:TODO_TOKEN = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
$env:PORT = "$Port"
$env:HOST = $BindHost
Write-Host ''
Write-Host "Je token (vul dit in de app in):  $($env:TODO_TOKEN)"
Write-Host "Open daarna:                      http://${BindHost}:$Port"
Write-Host ''
node server/main.ts

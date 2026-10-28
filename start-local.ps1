param(
  [ValidateSet('dev', 'identify')]
  [string]$Mode = 'dev'
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  # Volta may be installed even when this terminal has not inherited VOLTA_HOME.
  if (-not $env:VOLTA_HOME) {
    $voltaDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local\Volta'
    if (Test-Path -LiteralPath $voltaDirectory -PathType Container) {
      $env:VOLTA_HOME = $voltaDirectory
    }
  }
  if (-not (Test-Path -LiteralPath '.env.local')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
    Write-Host 'Создан .env.local. Заполните BOT_TOKEN и список ID перед запуском.'
    exit 1
  }
  & npm.cmd run $Mode
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
function Docker-Step {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker step failed (exit $LASTEXITCODE). Check the message above and rerun .\start.ps1." }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop (Linux containers) first.' }
Docker-Step info --format '{{.ServerVersion}}'
Docker-Step compose version
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
New-Item -ItemType Directory -Force .runtime | Out-Null
Write-Host 'Building the portal from pinned official Python/PyPI sources...'
Docker-Step compose build portal
Docker-Step compose run --rm --no-deps setup
Write-Host 'Starting PostgreSQL and Metabase. First startup may take several minutes...'
Docker-Step compose up -d --wait --wait-timeout 480 postgres metabase
Docker-Step compose run --rm --no-deps bootstrap
Docker-Step compose up -d --wait --wait-timeout 120 portal
Write-Host 'Ready. Open the loopback ports below (default Dashboard :8000, Metabase :3000).'
Docker-Step compose ps
Write-Host 'Metabase login: .runtime/admin-credentials.json (keep private).'

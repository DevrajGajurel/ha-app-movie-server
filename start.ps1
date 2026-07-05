$ErrorActionPreference = "Stop"
$appDir = Join-Path $PSScriptRoot "src\movie_server"
Set-Location $appDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required. Install Node 18+ and try again."
}

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Error ".env not found. Copy .env.example to .env and set MAIN_URL."
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
}

Write-Host "Starting Movie Server (local)..."
npm start

#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    if (-not (Test-Path -LiteralPath 'server\dist\index.js') -or
        -not (Test-Path -LiteralPath 'frontend\dist\index.html')) {
        throw 'Build the app first: npm ci; npm --prefix frontend ci; npm run build'
    }
    node server\dist\index.js
    if ($LASTEXITCODE -ne 0) { throw 'TenderLens stopped with an error.' }
} finally {
    Pop-Location
}

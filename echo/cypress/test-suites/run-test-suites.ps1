# Runs both suites and generates a final merged HTML report
# Suite 1: cross-browser (chrome, edge, webkit)
# Suite 2: chrome in 3 viewports

$ErrorActionPreference = "Continue"

# Ensure Cypress launches Electron app mode, not Node mode.
if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

# Use project-local Cypress cache for stability in this environment.
$env:CYPRESS_CACHE_FOLDER = "$PSScriptRoot\.cypress-cache"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " RUNNING BOTH CYPRESS SUITES" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

& "$PSScriptRoot/run-browser-tests.ps1"
$suite1Exit = $LASTEXITCODE

Write-Host ""

& "$PSScriptRoot/run-viewport-tests.ps1"
$suite2Exit = $LASTEXITCODE

$finalRoot = "reports/final"
if (Test-Path $finalRoot) {
    Remove-Item -Recurse -Force $finalRoot
}
New-Item -ItemType Directory -Path $finalRoot -Force | Out-Null

$jsonFiles = Get-ChildItem -Path "reports/suite-1-cross-browser", "reports/suite-2-chrome-viewports" -Recurse -Filter "mochawesome*.json" | Select-Object -ExpandProperty FullName
$combinedJson = "$finalRoot/final-combined-report.json"
$finalHtmlName = "final-test-report"

if ($jsonFiles.Count -gt 0) {
    & npx mochawesome-merge @jsonFiles -o $combinedJson
    & npx marge $combinedJson --reportDir $finalRoot --reportFilename $finalHtmlName
    Write-Host ""
    Write-Host "Final HTML report: $finalRoot/$finalHtmlName.html" -ForegroundColor Green
} else {
    Write-Host "No mochawesome JSON files found to generate final report." -ForegroundColor Red
}

if ($suite1Exit -ne 0 -or $suite2Exit -ne 0) {
    exit 1
}

exit 0

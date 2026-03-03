# Run All Tests - Multiple Browsers with HTML Reports
# Generates Mochawesome HTML reports for each browser
# Browsers: Chrome, Firefox, Edge, WebKit (Safari)

$ErrorActionPreference = "Continue"

# Configuration
$specPattern = "e2e/suites/[0-9]*.cy.js"
$envVersion = "staging"
$reportsDir = "reports"

# Desktop viewport
$viewportWidth = 1440
$viewportHeight = 900

# Browsers to test
$browsers = @("chrome", "firefox", "edge", "webkit")

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " CYPRESS MULTI-BROWSER TEST RUNNER" -ForegroundColor Cyan
Write-Host " (with Mochawesome HTML Reports)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Viewport: Desktop ($viewportWidth x $viewportHeight)"
Write-Host ""

# Clean up old reports
if (Test-Path $reportsDir) {
    Remove-Item -Recurse -Force $reportsDir
}
New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null

# Set viewport environment variables
$env:CYPRESS_viewportWidth = $viewportWidth
$env:CYPRESS_viewportHeight = $viewportHeight

$exitCodes = @()

foreach ($browser in $browsers) {
    Write-Host "----------------------------------------" -ForegroundColor Yellow
    Write-Host " Running tests: $browser" -ForegroundColor Yellow
    Write-Host "----------------------------------------" -ForegroundColor Yellow
    
    # Run Cypress
    npx cypress run --spec "$specPattern" --env version=$envVersion --browser $browser
    $exitCodes += $LASTEXITCODE
    
    Write-Host ""
}

# Clear environment variables
Remove-Item Env:CYPRESS_viewportWidth -ErrorAction SilentlyContinue
Remove-Item Env:CYPRESS_viewportHeight -ErrorAction SilentlyContinue

Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host " Generating Combined HTML Report..." -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan

# Merge all JSON reports into one
npx mochawesome-merge "$reportsDir/*.json" -o "$reportsDir/combined-report.json"

# Generate HTML report from merged JSON
npx marge "$reportsDir/combined-report.json" --reportDir "$reportsDir" --reportFilename "test-report"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " REPORT GENERATED!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host " Open: $reportsDir\test-report.html" -ForegroundColor White
Write-Host ""

# Open the report in browser
Start-Process "$reportsDir\test-report.html"

# Exit with failure if any tests failed
if ($exitCodes -contains 1) {
    exit 1
}
else {
    exit 0
}

# Run All Tests - Multiple Viewports with HTML Reports
# Generates Mochawesome HTML reports for each viewport
# Viewports: Mobile (375x667), Tablet (768x1024), Desktop (1440x900)

$ErrorActionPreference = "Continue"

# Configuration
$specPattern = "e2e/suites/[0-9]*.cy.js"
$browser = "chrome"
$envVersion = "staging"
$reportsDir = "reports"

# Viewport configurations
$viewports = @(
    @{ name = "mobile"; width = 375; height = 667 },
    @{ name = "tablet"; width = 768; height = 1024 },
    @{ name = "desktop"; width = 1440; height = 900 }
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " CYPRESS MULTI-VIEWPORT TEST RUNNER" -ForegroundColor Cyan
Write-Host " (with Mochawesome HTML Reports)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Clean up old reports
if (Test-Path $reportsDir) {
    Remove-Item -Recurse -Force $reportsDir
}
New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null

$exitCodes = @()

foreach ($viewport in $viewports) {
    $viewportName = $viewport.name
    $width = $viewport.width
    $height = $viewport.height
    
    Write-Host "----------------------------------------" -ForegroundColor Yellow
    Write-Host " Running tests: $viewportName ($width x $height)" -ForegroundColor Yellow
    Write-Host "----------------------------------------" -ForegroundColor Yellow
    
    # Set environment variables for viewport
    $env:CYPRESS_viewportWidth = $width
    $env:CYPRESS_viewportHeight = $height
    
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

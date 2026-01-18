# Cypress Test Runner - Runs all tests across Desktop, Tablet, and Mobile viewports
# Usage: .\run_all_tests.ps1 [-Environment staging|prod|testing] [-Headed]

param(
    [Parameter()]
    [ValidateSet("staging", "prod", "testing")]
    [string]$Environment = "staging",
    
    [Parameter()]
    [switch]$Headed = $false
)

# Configuration
$cypressDir = "$PSScriptRoot\echo\cypress"
$headedFlag = if ($Headed) { "--headed" } else { "" }

# Viewport configurations (matching cypress.env.json)
$viewports = @{
    "Desktop" = @{ width = 1440; height = 900 }
    "Tablet"  = @{ width = 768; height = 1024 }
    "Mobile"  = @{ width = 375; height = 667 }
}

# Test specs to run (in order)
$testSpecs = @(
    "01-login-logout.cy.js",
    "02-multilingual.cy.js",
    "03-create-project.cy.js",
    "04-create-delete-project.cy.js",
    "05-create-edit-delete-project.cy.js",
    "06-qr-code-language.cy.js",
    "07-announcements.cy.js"
)

# Initialize results tracking
$results = @()
$startTime = Get-Date

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CYPRESS MULTI-VIEWPORT TEST RUNNER" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Environment: $Environment" -ForegroundColor Yellow
Write-Host "Headed Mode: $Headed" -ForegroundColor Yellow
Write-Host "Test Specs:  $($testSpecs.Count)" -ForegroundColor Yellow
Write-Host "Viewports:   Desktop, Tablet, Mobile" -ForegroundColor Yellow
Write-Host ""

# Run tests for each viewport
foreach ($viewportName in @("Desktop", "Tablet", "Mobile")) {
    $viewport = $viewports[$viewportName]
    $width = $viewport.width
    $height = $viewport.height
    
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Magenta
    Write-Host "  $viewportName ($width x $height)" -ForegroundColor Magenta
    Write-Host "========================================" -ForegroundColor Magenta
    
    foreach ($spec in $testSpecs) {
        $specName = $spec -replace "\.cy\.js$", ""
        Write-Host ""
        Write-Host "Running: $specName..." -ForegroundColor White
        
        # Build the command
        $cmd = "npx cypress run --spec `"e2e/suites/$spec`" --env version=$Environment --config viewportWidth=$width,viewportHeight=$height $headedFlag"
        
        # Run the test
        Push-Location $cypressDir
        $testResult = & cmd /c "$cmd 2>&1"
        $exitCode = $LASTEXITCODE
        Pop-Location
        
        # Determine pass/fail
        $status = if ($exitCode -eq 0) { "PASS" } else { "FAIL" }
        $statusColor = if ($exitCode -eq 0) { "Green" } else { "Red" }
        
        Write-Host "  Result: $status" -ForegroundColor $statusColor
        
        # Store result
        $results += [PSCustomObject]@{
            Viewport = $viewportName
            Test     = $specName
            Status   = $status
            ExitCode = $exitCode
        }
    }
}

# Calculate summary
$endTime = Get-Date
$duration = $endTime - $startTime
$totalTests = $results.Count
$passedTests = ($results | Where-Object { $_.Status -eq "PASS" }).Count
$failedTests = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
$passRate = [math]::Round(($passedTests / $totalTests) * 100, 1)

# Print Summary
Write-Host ""
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "           TEST RESULTS SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Duration: $($duration.ToString('hh\:mm\:ss'))" -ForegroundColor White
Write-Host ""

# Group by viewport
foreach ($viewportName in @("Desktop", "Tablet", "Mobile")) {
    $viewportResults = $results | Where-Object { $_.Viewport -eq $viewportName }
    $viewportPassed = ($viewportResults | Where-Object { $_.Status -eq "PASS" }).Count
    $viewportTotal = $viewportResults.Count
    
    Write-Host "$viewportName Results:" -ForegroundColor Magenta
    foreach ($r in $viewportResults) {
        $icon = if ($r.Status -eq "PASS") { "[PASS]" } else { "[FAIL]" }
        $color = if ($r.Status -eq "PASS") { "Green" } else { "Red" }
        Write-Host "  $icon $($r.Test)" -ForegroundColor $color
    }
    Write-Host "  Score: $viewportPassed/$viewportTotal" -ForegroundColor Yellow
    Write-Host ""
}

# Final Score
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "         FINAL SCORE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$scoreColor = if ($passRate -ge 80) { "Green" } elseif ($passRate -ge 50) { "Yellow" } else { "Red" }
Write-Host "  Total:  $passedTests / $totalTests ($passRate%)" -ForegroundColor $scoreColor
Write-Host "  Passed: $passedTests" -ForegroundColor Green
Write-Host "  Failed: $failedTests" -ForegroundColor Red
Write-Host ""

# List failed tests
if ($failedTests -gt 0) {
    Write-Host "Failed Tests:" -ForegroundColor Red
    $results | Where-Object { $_.Status -eq "FAIL" } | ForEach-Object {
        Write-Host "  - [$($_.Viewport)] $($_.Test)" -ForegroundColor Red
    }
    Write-Host ""
}

Write-Host "========================================" -ForegroundColor Cyan

# Exit with appropriate code
if ($failedTests -gt 0) {
    exit 1
}
else {
    exit 0
}

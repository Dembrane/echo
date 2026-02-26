# Parallel Cypress Test Runner (Fixed)
# Runs all test suites in parallel using PowerShell background jobs

param(
    [int]$MaxParallel = 5,  # Max concurrent tests (adjust based on CPU/RAM)
    [string]$Browser = "chrome",
    [switch]$Headed,
    [string]$Version = "staging"
)

$ErrorActionPreference = "Continue"

# Get all test files (exclude .original files)
$testDir = "e2e/suites"
$testFiles = Get-ChildItem -Path $testDir -Filter "*.cy.js" | 
Where-Object { $_.Name -notlike "*.original.*" } | 
Sort-Object Name

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Parallel Cypress Test Runner" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Tests found: $($testFiles.Count)" -ForegroundColor Yellow
Write-Host "Max parallel: $MaxParallel" -ForegroundColor Yellow
Write-Host "Browser: $Browser" -ForegroundColor Yellow
Write-Host ""

# Create results directory
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$resultsDir = "parallel-results-$timestamp"
New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null

Write-Host "Starting parallel execution..." -ForegroundColor Green
Write-Host "Results will be saved to: $resultsDir" -ForegroundColor Gray
Write-Host ""

# Track jobs and results
$jobs = @()
$headedFlag = if ($Headed) { "--headed" } else { "--headless" }

# Launch tests in batches
foreach ($testFile in $testFiles) {
    $testName = $testFile.BaseName
    $specPath = "$testDir/$($testFile.Name)"
    $logFile = Join-Path (Get-Location) "$resultsDir\$testName.log"
    
    # Wait if we've hit max parallel jobs
    while (($jobs | Where-Object { $_.State -eq "Running" }).Count -ge $MaxParallel) {
        Start-Sleep -Seconds 3
    }
    
    Write-Host "Starting: $testName" -ForegroundColor Gray
    
    # Start background job - capture exit code properly
    $job = Start-Job -Name $testName -ScriptBlock {
        param($specPath, $version, $browser, $headedFlag, $logFile, $workDir)
        
        Set-Location $workDir
        $env:CYPRESS_viewportWidth = 1440
        $env:CYPRESS_viewportHeight = 900
        
        # Run cypress and capture output + exit code
        $output = & npx cypress run --spec $specPath --env version=$version --browser $browser $headedFlag 2>&1
        $exitCode = $LASTEXITCODE
        
        # Save output to log file
        $output | Out-File -FilePath $logFile -Encoding utf8
        
        # Return exit code as the job result
        return $exitCode
    } -ArgumentList $specPath, $Version, $Browser, $headedFlag, $logFile, (Get-Location).Path
    
    $jobs += $job
    Start-Sleep -Milliseconds 500
}

Write-Host ""
Write-Host "All $($jobs.Count) tests launched. Waiting for completion..." -ForegroundColor Yellow
Write-Host ""

# Wait for all jobs to complete
$jobs | Wait-Job | Out-Null

# Collect results
$results = @{}
foreach ($job in $jobs) {
    $exitCode = Receive-Job -Job $job
    
    # Determine status from exit code
    $status = if ($exitCode -eq 0) { "PASS" } else { "FAIL" }
    $color = if ($exitCode -eq 0) { "Green" } else { "Red" }
    
    Write-Host "[$status] $($job.Name)" -ForegroundColor $color
    $results[$job.Name] = @{ Status = $status; ExitCode = $exitCode }
}

# Cleanup jobs
$jobs | Remove-Job -Force

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$passed = ($results.Values | Where-Object { $_.Status -eq "PASS" }).Count
$failed = ($results.Values | Where-Object { $_.Status -eq "FAIL" }).Count
$total = $results.Count

Write-Host "Passed: $passed" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Green" })
Write-Host "Total:  $total" -ForegroundColor White
Write-Host ""
Write-Host "Logs saved to: $resultsDir" -ForegroundColor Gray

# List failed tests
if ($failed -gt 0) {
    Write-Host ""
    Write-Host "Failed Tests:" -ForegroundColor Red
    $results.GetEnumerator() | Where-Object { $_.Value.Status -eq "FAIL" } | ForEach-Object {
        Write-Host "  - $($_.Key)" -ForegroundColor Red
    }
}

# Exit with appropriate code
if ($failed -gt 0) { exit 1 } else { exit 0 }

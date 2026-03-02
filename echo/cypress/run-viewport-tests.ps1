# Suite 2: Chrome-only run in 3 viewports in parallel
# - 3 parallel jobs (mobile/tablet/desktop)
# - Failed runs are retried up to 3 times per viewport job

param(
    [string]$SpecPattern = "e2e/suites/[0-9]*.cy.js",
    [string]$Version = "staging",
    [string]$Browser = "chrome",
    [int]$MaxRunAttempts = 3
)

$ErrorActionPreference = "Continue"

# Ensure Cypress launches Electron app mode, not Node mode.
if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

# Use project-local Cypress cache for stability in this environment.
$env:CYPRESS_CACHE_FOLDER = "$PSScriptRoot\.cypress-cache"
$cypressExe = Get-ChildItem -Path $env:CYPRESS_CACHE_FOLDER -Recurse -Filter "Cypress.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cypressExe) {
    Write-Host "Cypress binary not found in local cache. Installing..." -ForegroundColor Yellow
    npx cypress install
}

$suiteRoot = "reports/suite-2-chrome-viewports"
$logsDir = "$suiteRoot/logs"
$viewports = @(
    @{ name = "mobile"; width = 375; height = 667 },
    @{ name = "tablet"; width = 768; height = 1024 },
    @{ name = "desktop"; width = 1440; height = 900 }
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " SUITE 2: CHROME + 3 VIEWPORTS (PARALLEL=3)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Browser: $Browser" -ForegroundColor Yellow
Write-Host "Viewports: $($viewports.name -join ', ')" -ForegroundColor Yellow
Write-Host "Spec Pattern: $SpecPattern" -ForegroundColor Yellow
Write-Host "Run retries: max $MaxRunAttempts attempts per viewport job" -ForegroundColor Yellow
Write-Host ""

if (Test-Path $suiteRoot) {
    Remove-Item -Recurse -Force $suiteRoot
}
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

$jobs = @()
$workDir = (Get-Location).Path

foreach ($viewport in $viewports) {
    $viewportName = $viewport.name
    $width = $viewport.width
    $height = $viewport.height
    $runReportDir = "$suiteRoot/$viewportName"
    $logFile = "$logsDir/$viewportName.log"

    $job = Start-Job -Name "suite2-$viewportName" -ScriptBlock {
        param($workDir, $browser, $specPattern, $version, $viewportName, $width, $height, $runReportDir, $logFile, $maxRunAttempts)

        Set-Location $workDir
        if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
        $env:CYPRESS_CACHE_FOLDER = "$workDir\.cypress-cache"
        $env:CYPRESS_viewportWidth = $width
        $env:CYPRESS_viewportHeight = $height

        $attempt = 0
        $exitCode = 1
        $allOutput = @()

        while ($attempt -lt $maxRunAttempts -and $exitCode -ne 0) {
            $attempt++

            if (Test-Path $runReportDir) {
                Remove-Item -Recurse -Force $runReportDir
            }
            New-Item -ItemType Directory -Path $runReportDir -Force | Out-Null

            $env:CYPRESS_MOCHAWESOME_REPORT_DIR = $runReportDir
            $attemptOutput = & npx cypress run --config-file cypress.config.js --spec $specPattern --env "version=$version" --browser $browser --reporter mochawesome 2>&1
            $exitCode = $LASTEXITCODE
            Remove-Item Env:CYPRESS_MOCHAWESOME_REPORT_DIR -ErrorAction SilentlyContinue

            $allOutput += "===== Attempt $attempt/$maxRunAttempts ($viewportName) ====="
            $allOutput += $attemptOutput
            $allOutput += ""
        }

        $allOutput | Out-File -FilePath $logFile -Encoding utf8

        Remove-Item Env:CYPRESS_viewportWidth -ErrorAction SilentlyContinue
        Remove-Item Env:CYPRESS_viewportHeight -ErrorAction SilentlyContinue

        return @{
            Name = $viewportName
            ExitCode = $exitCode
            LogFile = $logFile
            Attempts = $attempt
        }
    } -ArgumentList $workDir, $Browser, $SpecPattern, $Version, $viewportName, $width, $height, $runReportDir, $logFile, $MaxRunAttempts

    $jobs += $job
}

Write-Host "Started $($jobs.Count) jobs in parallel. Waiting..." -ForegroundColor Green
Write-Host ""

$jobs | Wait-Job | Out-Null

$results = @()
foreach ($job in $jobs) {
    $result = Receive-Job -Job $job
    $results += $result
    $status = if ($result.ExitCode -eq 0) { "PASS" } else { "FAIL" }
    $color = if ($result.ExitCode -eq 0) { "Green" } else { "Red" }
    Write-Host "[$status] $($result.Name) after $($result.Attempts) attempt(s) (log: $($result.LogFile))" -ForegroundColor $color
}

$jobs | Remove-Job -Force

$jsonFiles = Get-ChildItem -Path $suiteRoot -Recurse -Filter "mochawesome*.json" | Select-Object -ExpandProperty FullName
$combinedJson = "$suiteRoot/combined-report.json"
$htmlReportName = "suite-2-report"

if ($jsonFiles.Count -gt 0) {
    & npx mochawesome-merge @jsonFiles -o $combinedJson
    & npx marge $combinedJson --reportDir $suiteRoot --reportFilename $htmlReportName
    Write-Host ""
    Write-Host "Suite 2 HTML report: $suiteRoot/$htmlReportName.html" -ForegroundColor Cyan
} else {
    Write-Host "No mochawesome JSON files found for Suite 2." -ForegroundColor Red
}

$failed = ($results | Where-Object { $_.ExitCode -ne 0 }).Count
Write-Host ""
Write-Host "Suite 2 Summary: Passed=$($results.Count - $failed), Failed=$failed, Total=$($results.Count)" -ForegroundColor White

if ($failed -gt 0) {
    exit 1
}

exit 0

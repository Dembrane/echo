# Suite 1: Cross-browser run (Chrome + Firefox + WebKit) in parallel
# - 3 parallel jobs (one per browser)
# - Retries are per-spec (only failed specs rerun)

param(
    [string]$SpecPattern = "e2e/suites/[0-9]*.cy.js",
    [string]$Version = "staging",
    [int]$ViewportWidth = 1440,
    [int]$ViewportHeight = 900,
    [int]$MaxRetries = 2,
    [string[]]$Browsers = @("chrome", "firefox", "webkit")
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

$suiteRoot = "reports/suite-1-cross-browser"
$logsDir = "$suiteRoot/logs"
$screenshotsRoot = "$suiteRoot/screenshots"
$supportedBrowsers = @("chrome", "firefox", "webkit")
$browsers = @($Browsers | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
$invalidBrowsers = @($browsers | Where-Object { $_ -notin $supportedBrowsers })

if (-not $browsers -or $browsers.Count -eq 0) {
    throw "No browsers provided. Use -Browsers chrome,firefox,webkit"
}

if ($invalidBrowsers.Count -gt 0) {
    throw "Unsupported browser(s): $($invalidBrowsers -join ', '). Supported: $($supportedBrowsers -join ', ')"
}

function Remove-DirectoryHard {
    param(
        [string]$PathToRemove
    )

    if (Test-Path $PathToRemove) {
        cmd /c "if exist `"$PathToRemove`" rmdir /s /q `"$PathToRemove`""
    }
}

function Get-SpecFilesFromPattern {
    param(
        [string]$Pattern
    )

    $normalizedPattern = $Pattern -replace '/', '\\'
    $specFiles = Get-ChildItem -Path $normalizedPattern -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*.cy.js" -and $_.Name -notlike "*.original.*" } |
    Sort-Object FullName

    if (-not $specFiles -or $specFiles.Count -eq 0) {
        throw "No spec files found for pattern: $Pattern"
    }

    return $specFiles
}

function To-RelativePosixPath {
    param(
        [string]$BasePath,
        [string]$TargetPath
    )

    $resolvedBase = (Resolve-Path -Path $BasePath).Path
    $resolvedTarget = (Resolve-Path -Path $TargetPath).Path

    if ($resolvedTarget.StartsWith($resolvedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relative = $resolvedTarget.Substring($resolvedBase.Length).TrimStart('\', '/')
    }
    else {
        $relative = $resolvedTarget
    }

    return $relative -replace '\\', '/'
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " SUITE 1: CROSS-BROWSER (PARALLEL=3)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Browsers: $($browsers -join ', ')" -ForegroundColor Yellow
Write-Host "Spec Pattern: $SpecPattern" -ForegroundColor Yellow
Write-Host "Viewport: $ViewportWidth x $ViewportHeight" -ForegroundColor Yellow
Write-Host "Spec retries: max $MaxRetries retries per failed spec" -ForegroundColor Yellow
Write-Host ""

Remove-DirectoryHard -PathToRemove $suiteRoot
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
New-Item -ItemType Directory -Path $screenshotsRoot -Force | Out-Null

$jobs = @()
$workDir = (Get-Location).Path
$allSpecFiles = Get-SpecFilesFromPattern -Pattern $SpecPattern
$allSpecPaths = $allSpecFiles | ForEach-Object { To-RelativePosixPath -BasePath $workDir -TargetPath $_.FullName }

# Exclude recording/ingest-related flows from Firefox.
$firefoxIngestPattern = 'uploadAudioFile|openUploadModal|portal-onboarding-mic|portal-audio-|installParticipantAudioStubs|retranscribeConversation|videoplayback\.mp3|sampleaudio\.mp3|test-audio\.wav'
$firefoxAllowedSpecs = @()
$firefoxExcludedSpecs = @()

foreach ($spec in $allSpecFiles) {
    $content = Get-Content -Path $spec.FullName -Raw
    $relativeSpec = To-RelativePosixPath -BasePath $workDir -TargetPath $spec.FullName

    if ($content -match $firefoxIngestPattern) {
        $firefoxExcludedSpecs += $relativeSpec
    }
    else {
        $firefoxAllowedSpecs += $relativeSpec
    }
}

Write-Host "Total specs resolved: $($allSpecPaths.Count)" -ForegroundColor Yellow
Write-Host "Firefox excluded ingest specs: $($firefoxExcludedSpecs.Count)" -ForegroundColor Yellow
if ($firefoxExcludedSpecs.Count -gt 0) {
    foreach ($excludedSpec in $firefoxExcludedSpecs) {
        Write-Host "  - $excludedSpec" -ForegroundColor DarkYellow
    }
}
Write-Host ""

foreach ($browser in $browsers) {
    $effectiveSpecs = if ($browser -eq "firefox") { $firefoxAllowedSpecs } else { $allSpecPaths }

    if (-not $effectiveSpecs -or $effectiveSpecs.Count -eq 0) {
        Write-Host "[SKIP] $browser has no matching specs after filtering." -ForegroundColor DarkYellow
        continue
    }

    $runReportDir = "$suiteRoot/$browser"
    $browserScreenshotsDir = "$screenshotsRoot/$browser"
    $logFile = "$logsDir/$browser.log"
    $effectiveSpecArg = $effectiveSpecs -join ','

    $job = Start-Job -Name "suite1-$browser" -ScriptBlock {
        param($workDir, $browser, $effectiveSpecArg, $version, $viewportWidth, $viewportHeight, $runReportDir, $browserScreenshotsDir, $logFile, $maxRetries)

        function Remove-DirectoryHard {
            param([string]$PathToRemove)
            if (Test-Path $PathToRemove) {
                cmd /c "if exist `"$PathToRemove`" rmdir /s /q `"$PathToRemove`""
            }
        }

        Set-Location $workDir
        if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }

        $env:CYPRESS_CACHE_FOLDER = "$workDir\.cypress-cache"
        $env:CYPRESS_viewportWidth = $viewportWidth
        $env:CYPRESS_viewportHeight = $viewportHeight

        Remove-DirectoryHard -PathToRemove $runReportDir
        New-Item -ItemType Directory -Path $runReportDir -Force | Out-Null

        Remove-DirectoryHard -PathToRemove $browserScreenshotsDir
        New-Item -ItemType Directory -Path $browserScreenshotsDir -Force | Out-Null

        $specList = $effectiveSpecArg -split ',' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        $allOutput = @()
        $failedSpecs = @()
        $totalAttempts = 0

        foreach ($spec in $specList) {
            $specPassed = $false
            $attempt = 0
            $maxAttempts = $maxRetries + 1

            while ($attempt -lt $maxAttempts -and -not $specPassed) {
                $attempt++
                $totalAttempts++

                $attemptId = [guid]::NewGuid().ToString('N')
                $tmpReportDir = Join-Path $runReportDir "tmp-report-$attemptId"
                $tmpScreenshotsDir = Join-Path $browserScreenshotsDir "tmp-shots-$attemptId"

                New-Item -ItemType Directory -Path $tmpReportDir -Force | Out-Null
                New-Item -ItemType Directory -Path $tmpScreenshotsDir -Force | Out-Null

                $env:CYPRESS_MOCHAWESOME_REPORT_DIR = $tmpReportDir
                $attemptOutput = & npx cypress run --config-file cypress.config.js --spec $spec --env "version=$version" --browser $browser --config "screenshotsFolder=$tmpScreenshotsDir" --reporter mochawesome 2>&1
                $exitCode = $LASTEXITCODE
                Remove-Item Env:CYPRESS_MOCHAWESOME_REPORT_DIR -ErrorAction SilentlyContinue

                $allOutput += "===== Spec: $spec | Attempt $attempt/$maxAttempts ($browser) ====="
                $allOutput += $attemptOutput
                $allOutput += ""

                $tmpJsonFiles = Get-ChildItem -Path $tmpReportDir -Filter "mochawesome*.json" -ErrorAction SilentlyContinue
                $isFinalAttempt = ($attempt -eq $maxAttempts)

                if ($exitCode -eq 0) {
                    foreach ($jsonFile in $tmpJsonFiles) {
                        Move-Item -Path $jsonFile.FullName -Destination $runReportDir -Force
                    }

                    Remove-DirectoryHard -PathToRemove $tmpReportDir
                    Remove-DirectoryHard -PathToRemove $tmpScreenshotsDir
                    $specPassed = $true
                }
                else {
                    if ($isFinalAttempt) {
                        foreach ($jsonFile in $tmpJsonFiles) {
                            Move-Item -Path $jsonFile.FullName -Destination $runReportDir -Force
                        }

                        $finalShots = Get-ChildItem -Path $tmpScreenshotsDir -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime
                        if ($finalShots.Count -gt 0) {
                            $specSlug = [System.IO.Path]::GetFileNameWithoutExtension($spec) -replace '[^A-Za-z0-9._-]', '_'
                            $destSpecDir = Join-Path $browserScreenshotsDir $specSlug
                            New-Item -ItemType Directory -Path $destSpecDir -Force | Out-Null
                            $singleShotName = "$($specSlug)-final-failure$($finalShots[0].Extension)"
                            Copy-Item -Path $finalShots[0].FullName -Destination (Join-Path $destSpecDir $singleShotName) -Force
                        }

                        Remove-DirectoryHard -PathToRemove $tmpReportDir
                        Remove-DirectoryHard -PathToRemove $tmpScreenshotsDir
                        $failedSpecs += $spec
                    }
                    else {
                        Remove-DirectoryHard -PathToRemove $tmpReportDir
                        Remove-DirectoryHard -PathToRemove $tmpScreenshotsDir
                    }
                }
            }
        }

        $allOutput | Out-File -FilePath $logFile -Encoding utf8

        Remove-Item Env:CYPRESS_viewportWidth -ErrorAction SilentlyContinue
        Remove-Item Env:CYPRESS_viewportHeight -ErrorAction SilentlyContinue

        return @{
            Name = $browser
            ExitCode = if ($failedSpecs.Count -gt 0) { 1 } else { 0 }
            LogFile = $logFile
            TotalSpecs = $specList.Count
            FailedSpecCount = $failedSpecs.Count
            FailedSpecs = $failedSpecs
            TotalAttempts = $totalAttempts
            MaxRetries = $maxRetries
        }
    } -ArgumentList $workDir, $browser, $effectiveSpecArg, $Version, $ViewportWidth, $ViewportHeight, $runReportDir, $browserScreenshotsDir, $logFile, $MaxRetries

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

    Write-Host "[$status] $($result.Name) specs=$($result.TotalSpecs) failedSpecs=$($result.FailedSpecCount) totalAttempts=$($result.TotalAttempts) (log: $($result.LogFile))" -ForegroundColor $color

    if ($result.FailedSpecCount -gt 0) {
        foreach ($failedSpec in $result.FailedSpecs) {
            Write-Host "  - failed after retries: $failedSpec" -ForegroundColor DarkRed
        }
    }
}

$jobs | Remove-Job -Force

$jsonFiles = Get-ChildItem -Path $suiteRoot -Recurse -Filter "mochawesome*.json" |
Where-Object { $_.DirectoryName -notmatch 'tmp-report-' } |
Select-Object -ExpandProperty FullName
$combinedJson = "$suiteRoot/combined-report.json"
$htmlReportName = "suite-1-report"

if ($jsonFiles.Count -gt 0) {
    $jsonFilesForNode = $jsonFiles | ConvertTo-Json
    @"
const fs = require('fs');
const { merge } = require('mochawesome-merge');
const files = $jsonFilesForNode;
const outFile = '$combinedJson'.replace(/\\\\/g, '/');

merge({ files })
  .then((report) => {
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log('Reports merged to ' + outFile);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
"@ | node -

    & npx marge $combinedJson --reportDir $suiteRoot --reportFilename $htmlReportName
    Write-Host ""
    Write-Host "Suite 1 HTML report: $suiteRoot/$htmlReportName.html" -ForegroundColor Cyan
}
else {
    Write-Host "No mochawesome JSON files found for Suite 1." -ForegroundColor Red
}

$failed = ($results | Where-Object { $_.ExitCode -ne 0 }).Count
Write-Host ""
Write-Host "Suite 1 Summary: Passed=$($results.Count - $failed), Failed=$failed, Total=$($results.Count)" -ForegroundColor White

if ($failed -gt 0) {
    exit 1
}

exit 0

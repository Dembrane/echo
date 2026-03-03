param(
    [string]$SpecPattern = "e2e/suites/[0-9]*.cy.js",
    [string]$Version = "staging",
    [int]$ViewportWidth,
    [int]$ViewportHeight,
    [int]$MaxRetries = 2,
    [string]$Browser,
    [string]$SuiteId
)

$ErrorActionPreference = "Continue"

if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

$env:CYPRESS_CACHE_FOLDER = "$PSScriptRoot\.cypress-cache"
$cypressExe = Get-ChildItem -Path $env:CYPRESS_CACHE_FOLDER -Recurse -Filter "Cypress.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cypressExe) {
    Write-Host "Cypress binary not found in local cache. Installing..." -ForegroundColor Yellow
    npx cypress install
}

$suiteRoot = "reports/$SuiteId"
$logsDir = "$suiteRoot/logs"
$browserScreenshotsDir = "$suiteRoot/screenshots/$Browser"
$runReportDir = "$suiteRoot/$Browser"

function Remove-DirectoryHard {
    param([string]$PathToRemove)
    if (Test-Path $PathToRemove) {
        cmd /c "if exist `"$PathToRemove`" rmdir /s /q `"$PathToRemove`""
    }
}

function Get-SpecFilesFromPattern {
    param([string]$Pattern)
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
    param([string]$BasePath, [string]$TargetPath)
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
Write-Host " SUITE ($SuiteId): BROWSER: $Browser ($ViewportWidth x $ViewportHeight)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Remove-DirectoryHard -PathToRemove $runReportDir
Remove-DirectoryHard -PathToRemove $browserScreenshotsDir
$null = New-Item -ItemType Directory -Path $runReportDir -Force
$null = New-Item -ItemType Directory -Path $browserScreenshotsDir -Force
$null = New-Item -ItemType Directory -Path $logsDir -Force

$workDir = (Get-Location).Path
$allSpecFiles = Get-SpecFilesFromPattern -Pattern $SpecPattern

if ($Browser.ToLowerInvariant() -eq "edge") {
    $edgeExcludePattern = 'uploadAudioFile|openUploadModal|portal-onboarding-mic|portal-audio-|installParticipantAudioStubs|retranscribeConversation|videoplayback\.mp3|sampleaudio\.mp3|test-audio\.wav|startRecording|stopRecording|getPortalUrl'
    $filteredFiles = @()
    foreach ($specFile in $allSpecFiles) {
        $content = Get-Content -Path $specFile.FullName -Raw
        if ($content -match $edgeExcludePattern) {
            Write-Host "[SKIP] $($specFile.Name) excluded for Edge (Recording Flow)" -ForegroundColor DarkYellow
        }
        else {
            $filteredFiles += $specFile
        }
    }
    $allSpecFiles = $filteredFiles
}

$allSpecPaths = $allSpecFiles | ForEach-Object { To-RelativePosixPath -BasePath $workDir -TargetPath $_.FullName }

$env:CYPRESS_viewportWidth = $ViewportWidth
$env:CYPRESS_viewportHeight = $ViewportHeight

$allOutput = @()
$failedSpecs = @()
$totalAttempts = 0

foreach ($spec in $allSpecPaths) {
    $specPassed = $false
    $attempt = 0
    $maxAttempts = $MaxRetries + 1

    while ($attempt -lt $maxAttempts -and -not $specPassed) {
        $attempt++
        $totalAttempts++
        $attemptId = [guid]::NewGuid().ToString('N')
        $tmpReportDir = Join-Path $runReportDir "tmp-report-$attemptId"
        $tmpScreenshotsDir = Join-Path $browserScreenshotsDir "tmp-shots-$attemptId"
        
        $null = New-Item -ItemType Directory -Path $tmpReportDir -Force
        $null = New-Item -ItemType Directory -Path $tmpScreenshotsDir -Force

        $env:CYPRESS_MOCHAWESOME_REPORT_DIR = $tmpReportDir
        $attemptOutput = & npx cypress run --config-file cypress.config.js --spec $spec --env "version=$Version" --browser $Browser --config "screenshotsFolder=$tmpScreenshotsDir" --reporter mochawesome 2>&1
        $exitCode = $LASTEXITCODE
        Remove-Item Env:CYPRESS_MOCHAWESOME_REPORT_DIR -ErrorAction SilentlyContinue

        $allOutput += "===== Spec: $spec | Attempt $attempt/$maxAttempts ($Browser) ====="
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
            Write-Host "[PASS] $spec" -ForegroundColor Green
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
                    $null = New-Item -ItemType Directory -Path $destSpecDir -Force
                    $singleShotName = "$($specSlug)-final-failure$($finalShots[0].Extension)"
                    Copy-Item -Path $finalShots[0].FullName -Destination (Join-Path $destSpecDir $singleShotName) -Force
                }
                Remove-DirectoryHard -PathToRemove $tmpReportDir
                Remove-DirectoryHard -PathToRemove $tmpScreenshotsDir
                $failedSpecs += $spec
                Write-Host "[FAIL] $spec after $maxAttempts attempts" -ForegroundColor Red
            }
            else {
                Remove-DirectoryHard -PathToRemove $tmpReportDir
                Remove-DirectoryHard -PathToRemove $tmpScreenshotsDir
                Write-Host "[RETRY] $spec failed on attempt $attempt" -ForegroundColor Yellow
            }
        }
    }
}

$logFile = "$logsDir/$Browser.log"
$allOutput | Out-File -FilePath $logFile -Encoding utf8

Remove-Item Env:CYPRESS_viewportWidth -ErrorAction SilentlyContinue
Remove-Item Env:CYPRESS_viewportHeight -ErrorAction SilentlyContinue

# Merge reports and create html
$jsonFiles = Get-ChildItem -Path $runReportDir -Filter "mochawesome*.json" | Select-Object -ExpandProperty FullName
$combinedJson = "$runReportDir/combined-report.json"
$htmlReportName = "test-report"

if ($jsonFiles.Count -gt 0) {
    # Provide json files content as an array 
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

    & npx marge $combinedJson --reportDir $runReportDir --reportFilename $htmlReportName
    Write-Host ""
    Write-Host "HTML report generated: $runReportDir/$htmlReportName.html" -ForegroundColor Cyan
}

if ($failedSpecs.Count -gt 0) {
    Write-Host ""
    Write-Host "FAILED SPECS:" -ForegroundColor Red
    foreach ($failedSpec in $failedSpecs) {
        Write-Host "  - $failedSpec" -ForegroundColor DarkRed
    }
    exit 1
}

Write-Host "All specs passed for $Browser ($SuiteId)!" -ForegroundColor Green
exit 0

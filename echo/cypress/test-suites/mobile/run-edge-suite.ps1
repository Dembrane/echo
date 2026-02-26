$ErrorActionPreference = "Continue"

Push-Location "$PSScriptRoot\.."
try {
    # Skip recording/audio tests for Edge
    $specFilesToRun = ""
    $allSpecFiles = Get-ChildItem -Path "e2e/suites" -Filter "*.cy.js" -File
    $edgeExcludePattern = 'uploadAudioFile|openUploadModal|portal-onboarding-mic|portal-audio-|installParticipantAudioStubs|retranscribeConversation|videoplayback\.mp3|sampleaudio\.mp3|test-audio\.wav|startRecording|stopRecording|getPortalUrl'
    
    foreach ($specFile in $allSpecFiles) {
        $content = Get-Content -Path $specFile.FullName -Raw
        if ($content -notmatch $edgeExcludePattern) {
            $specFilesToRun += "e2e/suites/$($specFile.Name),"
        }
    }
    
    $specFilesToRun = $specFilesToRun.TrimEnd(',')

    if ([string]::IsNullOrWhiteSpace($specFilesToRun)) {
        Write-Host "No specs to run after filtering." -ForegroundColor Yellow
        exit 0
    }

    & .\run-core-suite.ps1 -ViewportWidth 375 -ViewportHeight 667 -Browser "edge" -SuiteId "mobile" -SpecPattern $specFilesToRun
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

$ErrorActionPreference = "Continue"

Push-Location "$PSScriptRoot\.."
try {
    & .\run-core-suite.ps1 -ViewportWidth 768 -ViewportHeight 1024 -Browser "chrome" -SuiteId "tablet"
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

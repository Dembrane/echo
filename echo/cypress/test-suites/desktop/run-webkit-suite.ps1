$ErrorActionPreference = "Continue"

Push-Location "$PSScriptRoot\.."
try {
    & .\run-core-suite.ps1 -ViewportWidth 1440 -ViewportHeight 900 -Browser "webkit" -SuiteId "desktop"
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

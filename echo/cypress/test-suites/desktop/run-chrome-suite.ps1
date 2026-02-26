$ErrorActionPreference = "Continue"

Push-Location "$PSScriptRoot\.."
try {
    & .\run-core-suite.ps1 -ViewportWidth 1440 -ViewportHeight 900 -Browser "chrome" -SuiteId "desktop"
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

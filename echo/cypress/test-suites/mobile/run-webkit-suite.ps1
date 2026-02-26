$ErrorActionPreference = "Continue"

Push-Location "$PSScriptRoot\.."
try {
    & .\run-core-suite.ps1 -ViewportWidth 375 -ViewportHeight 667 -Browser "webkit" -SuiteId "mobile"
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

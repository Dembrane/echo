$ErrorActionPreference = "Continue"

Push-Location "$PSScriptRoot\..\.."
try {
    & .\test-suites\run-core-suite.ps1 -ViewportWidth 768 -ViewportHeight 1024 -Browser "webkit" -SuiteId "tablet"
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

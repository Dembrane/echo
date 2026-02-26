$ErrorActionPreference = "Continue"

Push-Location "$PSScriptRoot\..\.."
try {
    & .\test-suites\run-core-suite.ps1 -ViewportWidth 375 -ViewportHeight 667 -Browser "chrome" -SuiteId "mobile"
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

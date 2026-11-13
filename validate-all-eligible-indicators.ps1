param(
    [string]$WorkerBaseUrl = "https://chama-market-proxy.yanick-lee.workers.dev",
    [string]$BaseScript = ".\test-indicator-accuracy-fixed.ps1"
)

$ErrorActionPreference = "Stop"
$WorkerBaseUrl = $WorkerBaseUrl.TrimEnd("/")
$BaseScriptPath = (Resolve-Path $BaseScript).Path

Write-Host "Read-only full validation for all eligible stocks" -ForegroundColor Cyan
Write-Host "Worker: $WorkerBaseUrl"
Write-Host "Minimum candles: 120"
Write-Host "No database writes will be performed."
Write-Host ""

$auditUrl = "$WorkerBaseUrl/api/data/audit?minCandles=120&details=1"
Write-Host "Fetching eligible stock list from audit endpoint..." -ForegroundColor Yellow
$audit = Invoke-RestMethod -Uri $auditUrl -Method Get -TimeoutSec 120

if (-not $audit.ok) {
    throw "Audit endpoint returned ok=false."
}
if (-not $audit.eligibleStocks) {
    throw "The Worker does not return eligibleStocks. Apply the read-only Worker patch described in the accompanying instructions and deploy it first."
}

$codes = @($audit.eligibleStocks | ForEach-Object { [string]$_.code } | Where-Object { $_ -match '^\d{6}$' } | Sort-Object -Unique)
if ($codes.Count -eq 0) {
    throw "No eligible stock codes were returned."
}
if ($audit.eligibleForIndicators -ne $codes.Count) {
    Write-Warning "Audit eligible count ($($audit.eligibleForIndicators)) differs from returned code count ($($codes.Count))."
}

Write-Host "Eligible stocks: $($codes.Count)" -ForegroundColor Green
Write-Host "Starting independent EMA / RSI / MACD recalculation..."
Write-Host ""

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BaseScriptPath -WorkerBaseUrl $WorkerBaseUrl -Codes $codes
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    throw "Base validation script exited with code $exitCode."
}

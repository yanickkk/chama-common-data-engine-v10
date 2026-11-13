param(
  [Parameter(Mandatory=$true)][string]$WorkerBaseUrl,
  [int]$TotalStocks = 4008,
  [int]$StartOffset = 0,
  [int]$BatchSize = 5,
  [int]$DelaySeconds = 2,
  [int]$MinCandles = 120
)
$ErrorActionPreference = 'Stop'
$base = $WorkerBaseUrl.TrimEnd('/')
$size = [Math]::Min(5, [Math]::Max(1, $BatchSize))
$logPath = Join-Path $PSScriptRoot 'indicator-v10.7-log.txt'
"START $(Get-Date -Format o) offset=$StartOffset batch=$size minCandles=$MinCandles" | Add-Content -Path $logPath
for ($offset = $StartOffset; $offset -lt $TotalStocks; $offset += $size) {
  $url = "$base/api/data/sync?type=indicators&limit=$size&offset=$offset&minCandles=$MinCandles"
  try {
    $r = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 90
    $next = if ($null -ne $r.nextOffset) { [int]$r.nextOffset } else { $offset + $size }
    $line = "INDICATORS offset=$offset processed=$($r.processed) skipped=$($r.skipped) limited=$($r.limitedHistory) full=$($r.fullHistory) rows=$($r.indicatorRowsSaved) failed=$($r.failed) next=$next"
    Write-Host $line -ForegroundColor Green
    Add-Content -Path $logPath -Value $line
    if ($r.failed -gt 0) { Add-Content -Path $logPath -Value (($r.errors | ConvertTo-Json -Compress -Depth 6)) }
    if ($next -le $offset) { throw "nextOffset가 진행되지 않습니다. 응답=$($r | ConvertTo-Json -Compress -Depth 5)" }
    $offset = $next - $size
    Start-Sleep -Seconds $DelaySeconds
  }
  catch {
    $line = "STOP offset=$offset reason=$($_.Exception.Message)"
    Write-Host $line -ForegroundColor Red
    Add-Content -Path $logPath -Value $line
    Write-Host "재개 명령: .\run-indicators-only.ps1 -WorkerBaseUrl `"$base`" -TotalStocks $TotalStocks -StartOffset $offset -BatchSize 1 -DelaySeconds $DelaySeconds -MinCandles $MinCandles" -ForegroundColor Yellow
    exit 2
  }
}
"DONE $(Get-Date -Format o)" | Add-Content -Path $logPath
Write-Host "지표 계산 배치가 완료되었습니다. 로그: $logPath" -ForegroundColor Cyan

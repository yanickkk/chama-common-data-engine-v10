param(
  [Parameter(Mandatory=$true)][string]$WorkerBaseUrl,
  [int]$TotalStocks = 4008,
  [int]$Days = 700,
  [int]$StartOffset = 0,
  [int]$CandleBatchSize = 1,
  [int]$IndicatorBatchSize = 5,
  [switch]$SkipIndicators
)
$ErrorActionPreference = 'Stop'
$base = $WorkerBaseUrl.TrimEnd('/')
$size = 1 # v10.7은 종목당 여러 날짜 구간을 순차 조회하므로 일봉 배치는 1개로 고정
$logPath = Join-Path $PSScriptRoot "batch-v10.7-log.txt"

function Invoke-Batch([string]$Url) {
  try {
    return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 120
  }
  catch {
    $msg = $_.Exception.Message
    if ($msg -match '1102|Worker exceeded|CPU') {
      throw "Cloudflare 1102 감지: 같은 요청을 반복하지 않고 중단합니다. 종목 단독 재시도 또는 Worker 실행시간을 점검하세요. 원문: $msg"
    }
    throw
  }
}

function Run-CandleBatches {
  param([int]$FromOffset)
  Write-Host "Phase 1: Naver siseJson 과거 일봉 수집 (batch=1, start=$FromOffset, days=$Days)" -ForegroundColor Cyan
  for ($offset = $FromOffset; $offset -lt $TotalStocks; $offset += $size) {
    $url = "$base/api/data/sync?type=candles&provider=naver-legacy&days=$Days&limit=1&offset=$offset"
    try {
      $r = Invoke-Batch $url
      $next = if ($null -ne $r.nextOffset) { [int]$r.nextOffset } else { $offset + [int]$r.processed }
      $line = "CANDLES offset=$offset processed=$($r.processed) saved=$($r.candlesSaved) failed=$($r.failed) next=$next"
      Write-Host $line -ForegroundColor Green
      Add-Content -Path $logPath -Value $line
      if ($r.failed -gt 0) { Add-Content -Path $logPath -Value (($r.errors | ConvertTo-Json -Compress -Depth 6)) }
      if ($next -le $offset) { throw "nextOffset가 진행되지 않습니다. 응답=$($r | ConvertTo-Json -Compress -Depth 5)" }
      $offset = $next - $size
      Start-Sleep -Milliseconds 900
    }
    catch {
      $line = "STOP candles offset=$offset reason=$($_.Exception.Message)"
      Write-Host $line -ForegroundColor Red
      Add-Content -Path $logPath -Value $line
      Write-Host "재개 명령: .\run-data-batches.ps1 -WorkerBaseUrl `"$base`" -TotalStocks $TotalStocks -Days $Days -StartOffset $offset -SkipIndicators" -ForegroundColor Yellow
      return $false
    }
  }
  return $true
}

function Run-IndicatorBatches {
  $indicatorSize = [Math]::Min(5, [Math]::Max(1, $IndicatorBatchSize))
  Write-Host "Phase 2: 지표 계산 (batch=$indicatorSize, minCandles=120)" -ForegroundColor Cyan
  for ($offset = 0; $offset -lt $TotalStocks; $offset += $indicatorSize) {
    $url = "$base/api/data/sync?type=indicators&limit=$indicatorSize&offset=$offset&minCandles=120"
    try {
      $r = Invoke-Batch $url
      $next = if ($null -ne $r.nextOffset) { [int]$r.nextOffset } else { $offset + [int]$r.processed }
      $line = "INDICATORS offset=$offset processed=$($r.processed) skipped=$($r.skipped) limited=$($r.limitedHistory) full=$($r.fullHistory) rowsSaved=$($r.indicatorRowsSaved) failed=$($r.failed) next=$next"
      Write-Host $line -ForegroundColor Green
      Add-Content -Path $logPath -Value $line
      if ($r.failed -gt 0) { Add-Content -Path $logPath -Value (($r.errors | ConvertTo-Json -Compress -Depth 6)) }
      if ($next -le $offset) { throw "nextOffset가 진행되지 않습니다. 응답=$($r | ConvertTo-Json -Compress -Depth 5)" }
      $offset = $next - $indicatorSize
      Start-Sleep -Milliseconds 700
    }
    catch {
      $line = "STOP indicators offset=$offset reason=$($_.Exception.Message)"
      Write-Host $line -ForegroundColor Red
      Add-Content -Path $logPath -Value $line
      Write-Host "지표 계산 재개: .\run-indicators-only.ps1 -WorkerBaseUrl `"$base`" -TotalStocks $TotalStocks -StartOffset $offset" -ForegroundColor Yellow
      return $false
    }
  }
  return $true
}

"START $(Get-Date -Format o) startOffset=$StartOffset candleBatch=1 days=$Days" | Add-Content -Path $logPath
$candlesOk = Run-CandleBatches -FromOffset $StartOffset
if (-not $candlesOk) { exit 2 }
if (-not $SkipIndicators) {
  $indicatorsOk = Run-IndicatorBatches
  if (-not $indicatorsOk) { exit 3 }
}
"DONE $(Get-Date -Format o)" | Add-Content -Path $logPath
Write-Host "작업 종료. 로그: $logPath" -ForegroundColor Cyan

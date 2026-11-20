param(
  [string]$BaseUrl = "https://chama-market-proxy.yanick-lee.workers.dev",
  [int]$MaxSteps = 25,
  [int]$DelaySeconds = 2,
  [switch]$StartFresh
)
$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 reads UTF-8 scripts correctly only when the file has a BOM.
# Switch the Windows console code page as well as .NET and native-pipeline encodings.
try {
  & "$env:SystemRoot\System32\chcp.com" 65001 > $null
} catch {
  # PowerShell 7 terminals are normally UTF-8 already; continue with .NET settings.
}
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
if ($MaxSteps -lt 1) { throw "MaxSteps는 1 이상이어야 합니다." }
if ($DelaySeconds -lt 0) { throw "DelaySeconds는 0 이상이어야 합니다." }
$BaseUrl = $BaseUrl.TrimEnd("/")
function Invoke-HistoryJob([string]$Action) {
  $uri = "$BaseUrl/api/data/history-job?action=$Action"
  Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 180
}
function Test-D1ReadLimitError([string]$Message) {
  return $Message -match '(?i)D1_ERROR|free tier daily row read limit|daily row read limit|exceeded.*row read'
}
Write-Host "차마 공통 데이터 엔진 - 일봉 과거 데이터 보충"
Write-Host "Worker: $BaseUrl"
Write-Host "이번 실행 최대 종목 수: $MaxSteps"
Write-Host ""
$state = Invoke-HistoryJob "status"
$processedNow = if ($state.job) { $state.job.processed } else { 0 }
$pendingLabel = if ($null -eq $state.pendingQueue) { "상태 조회 생략(읽기 절약)" } else { [string]$state.pendingQueue }
Write-Host ("현재 상태: {0} / 처리 종목: {1} / 대기열: {2}" -f $state.status, $processedNow, $pendingLabel)
if ($StartFresh) {
  Write-Warning "StartFresh: 작업 커서를 처음으로 초기화합니다. 기존 일봉/지표 데이터는 삭제하지 않습니다."
  $state = Invoke-HistoryJob "start"
}
elseif ($state.status -eq "idle") {
  $state = Invoke-HistoryJob "start"
}
elseif ($state.status -eq "completed") {
  Write-Host "이미 완료된 작업입니다. 새로 시작하려면 -StartFresh 옵션을 명시하세요."
  exit 0
}
elseif ($state.status -ne "running") {
  $state = Invoke-HistoryJob "resume"
}
if ($state.status -ne "running") {
  Write-Host ("작업을 시작할 수 없습니다. 현재 상태: {0}" -f $state.status)
  exit 1
}
for ($i = 1; $i -le $MaxSteps; $i++) {
  try {
    $r = Invoke-HistoryJob "step"
  }
  catch {
    $message = $_.Exception.Message
    if (Test-D1ReadLimitError $message) {
      Write-Warning "Cloudflare D1 읽기 한도 오류입니다. 추가 status/step 요청을 보내지 않고 즉시 중단합니다."
      Write-Warning "백필 작업 커서와 기존 데이터는 그대로 둡니다. UTC 자정 이후 상태 확인 후 재개하세요."
      Write-Warning $message
      exit 2
    }
    throw
  }
  if ($r.status -eq "running") {
    $p = $r.progress
    Write-Host ("[{0}/{1}] {2} {3} | 기존 {4}일 | 신규 {5} / 수정 {6} | 지표 {7}행 | 예약 {8}/{9}" -f $i, $MaxSteps, $r.code, $r.name, $r.priorCandleCount, $r.candleResult.candlesSaved, $r.candleResult.candlesUpdated, $r.candleResult.indicatorRowsProcessed, $p.dailyReservedWrites, $p.dailyBudgetWrites)
  }
  elseif ($r.status -eq "busy") {
    Write-Host "다른 요청이 처리 중입니다. 잠시 후 다시 시도합니다."
    $i--
  }
  else {
    Write-Host ""
    Write-Host ("작업 상태: {0}" -f $r.status)
    if ($r.message) { Write-Host $r.message }
    if ($r.error) { Write-Host ("오류: {0}" -f $r.error) }
    break
  }
  if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
}
Write-Host ""
try {
  $final = Invoke-HistoryJob "status"
  Write-Host ("최종 상태: {0}" -f $final.status)
  $finalPending = if ($null -eq $final.pendingQueue) { "조회 생략" } else { [string]$final.pendingQueue }
  Write-Host ("처리 종목: {0}, 대기열: {1}" -f $final.job.processed, $finalPending)
}
catch {
  if (Test-D1ReadLimitError $_.Exception.Message) {
    Write-Warning "D1 읽기 한도 때문에 최종 상태 조회를 생략했습니다. 백필 처리 결과는 각 성공 응답에 저장되어 있습니다."
  } else { throw }
}
if ($final.job) {
  Write-Host ("누적 일봉 신규: {0}, 수정: {1}, 지표 재계산 종목: {2}, 지표 행: {3}" -f $final.job.candles_inserted, $final.job.candles_updated, $final.job.indicators_recalculated, $final.job.indicator_rows_processed)
  Write-Host ("UTC 일일 예약 쓰기량: {0}/{1}" -f $final.job.daily_reserved_writes, $final.job.daily_budget_writes)
}

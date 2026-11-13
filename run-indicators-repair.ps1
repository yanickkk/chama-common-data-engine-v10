param(
    [Parameter(Mandatory=$true)][string]$WorkerBaseUrl,
    [int]$MinCandles = 120,
    [string]$StartAfterCode = '000000',
    [int]$DelaySeconds = 1,
    [int]$MaxRequests = 500
)

$ErrorActionPreference = 'Stop'
$base = $WorkerBaseUrl.TrimEnd('/')
$afterCode = $StartAfterCode
$logPath = Join-Path $PSScriptRoot 'indicator-repair-log.txt'
$requests = 0
$totalProcessed = 0
$totalSaved = 0
$totalFailed = 0
$totalSkipped = 0

if ($MinCandles -lt 120 -or $MinCandles -gt 250) { throw 'MinCandles는 120~250 사이여야 합니다.' }
if ($DelaySeconds -lt 1) { $DelaySeconds = 1 }
if ($MaxRequests -lt 1) { throw 'MaxRequests는 1 이상이어야 합니다.' }

Write-Host '기술적 지표 누락/부분 복구 시작' -ForegroundColor Cyan
Write-Host "Worker: $base" -ForegroundColor Gray
Write-Host "최소 일봉: $MinCandles / 시작 코드 이후: $afterCode" -ForegroundColor Gray
Write-Host '종목당 1회 요청으로 처리하며, 이미 완성된 종목은 자동 제외합니다.' -ForegroundColor Gray

while ($requests -lt $MaxRequests) {
    $encodedAfter = [uri]::EscapeDataString($afterCode)
    $url = "$base/api/data/sync?type=indicators-repair&limit=1&minCandles=$MinCandles&afterCode=$encodedAfter"

    try {
        $result = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 120
    }
    catch {
        $line = "STOP afterCode=$afterCode reason=$($_.Exception.Message)"
        Add-Content -Path $logPath -Value $line
        Write-Host $line -ForegroundColor Red
        Write-Host "중단 위치를 기록했습니다. 같은 명령으로 다시 실행하거나 -StartAfterCode `"$afterCode`" 로 재개하세요." -ForegroundColor Yellow
        exit 1
    }

    $requests++
    if (-not $result.ok) {
        $line = "STOP afterCode=$afterCode reason=API returned ok=false"
        Add-Content -Path $logPath -Value $line
        Write-Host $line -ForegroundColor Red
        exit 2
    }

    if ($result.done -eq $true) {
        Write-Host '복구 대상 종목이 더 이상 없습니다.' -ForegroundColor Green
        break
    }

    $processed = [int]$result.processed
    $saved = [int]$result.indicatorRowsSaved
    $failed = [int]$result.failed
    $skipped = [int]$result.skipped
    $codes = if ($result.selectedCodes) { $result.selectedCodes -join ',' } else { $result.nextCode }
    $line = "REQUEST=$requests CODE=$codes processed=$processed rowsSaved=$saved skipped=$skipped failed=$failed nextCode=$($result.nextCode)"
    Add-Content -Path $logPath -Value $line
    Write-Host $line -ForegroundColor $(if ($failed -gt 0) { 'Yellow' } else { 'Green' })

    if ($failed -gt 0 -and $result.errors) {
        ($result.errors | ConvertTo-Json -Compress -Depth 6) | Add-Content -Path $logPath
        $totalFailed += $failed
    }
    $totalProcessed += $processed
    $totalSaved += $saved
    $totalSkipped += $skipped

    if (-not $result.nextCode -or $result.nextCode -le $afterCode) {
        Write-Host 'nextCode가 진행되지 않아 안전하게 중단합니다.' -ForegroundColor Red
        exit 3
    }
    $afterCode = [string]$result.nextCode
    Start-Sleep -Seconds $DelaySeconds
}

if ($requests -ge $MaxRequests) {
    Write-Host "최대 요청 수($MaxRequests)에 도달했습니다. -StartAfterCode `"$afterCode`" 로 이어서 실행할 수 있습니다." -ForegroundColor Yellow
}

Write-Host ''
Write-Host '이번 실행 요약' -ForegroundColor Cyan
Write-Host "요청 수: $requests"
Write-Host "복구 성공 종목: $totalProcessed"
Write-Host "지표 저장 시도 행: $totalSaved (실제 변경 행 수와 다를 수 있음)"
Write-Host "건너뜀: $totalSkipped / 실패: $totalFailed"
Write-Host "마지막 처리 코드: $afterCode"
Write-Host "로그: $logPath"
Write-Host "다음 확인: $base/api/data/audit?minCandles=$MinCandles"

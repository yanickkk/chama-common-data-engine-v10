param(
    [string]$WorkerBaseUrl = "https://chama-market-proxy.yanick-lee.workers.dev",
    [string]$BaseScript = ".\test-indicator-accuracy-fixed.ps1",
    [int]$MaxStocksPerRun = 10,
    [string]$ProgressFile = ".\indicator-validation-progress.json",
    [switch]$Reset
)

$ErrorActionPreference = "Stop"
$WorkerBaseUrl = $WorkerBaseUrl.TrimEnd("/")

if ($MaxStocksPerRun -lt 1) {
    throw "MaxStocksPerRun must be 1 or greater."
}
if (-not (Test-Path -LiteralPath $BaseScript)) {
    throw "Base validation script not found: $BaseScript"
}
$BaseScriptPath = (Resolve-Path -LiteralPath $BaseScript).Path

# Reset removes only the local progress file. It does not touch Worker or D1.
if ($Reset -and (Test-Path -LiteralPath $ProgressFile)) {
    Remove-Item -LiteralPath $ProgressFile -Force
}

$state = $null
if (Test-Path -LiteralPath $ProgressFile) {
    try {
        $state = Get-Content -LiteralPath $ProgressFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "Cannot read progress file. Back it up or use -Reset to start over. Details: $($_.Exception.Message)"
    }
}

# Fetch the eligible stock list only on the first run. Later runs reuse the local checkpoint.
if ($null -eq $state) {
    Write-Host "Fetching eligible stock list from Worker audit..." -ForegroundColor Yellow
    $auditUrl = "$WorkerBaseUrl/api/data/audit?minCandles=120&details=1"
    $audit = Invoke-RestMethod -Uri $auditUrl -Method Get -TimeoutSec 120

    if (-not $audit.ok -or -not $audit.eligibleStocks) {
        throw "Audit failed or eligibleStocks was not returned. Check the Worker audit endpoint."
    }

    $codes = @(
        $audit.eligibleStocks |
        ForEach-Object { ([string]$_.code).Trim().PadLeft(6, '0') } |
        Where-Object { $_ -match '^\d{6}$' } |
        Sort-Object -Unique
    )

    if ($codes.Count -eq 0) {
        throw "No eligible stock codes were returned."
    }
    if ($audit.eligibleForIndicators -ne $codes.Count) {
        Write-Warning "Audit eligible count ($($audit.eligibleForIndicators)) differs from unique code count ($($codes.Count))."
    }

    $state = [pscustomobject]@{
        workerBaseUrl = $WorkerBaseUrl
        minCandles = 120
        eligibleCount = $codes.Count
        codes = @($codes)
        completed = @()
        results = @()
        createdAt = (Get-Date).ToString("o")
        updatedAt = (Get-Date).ToString("o")
    }

    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ProgressFile -Encoding UTF8
    Write-Host "Saved $($codes.Count) eligible codes to local checkpoint: $ProgressFile" -ForegroundColor Green
}
else {
    if ($state.workerBaseUrl -ne $WorkerBaseUrl) {
        throw "Progress file belongs to a different Worker URL. Use the matching URL or -Reset."
    }
    Write-Host "Resuming from local checkpoint: $ProgressFile" -ForegroundColor Cyan
}

$completedSet = @{}
foreach ($item in @($state.completed)) {
    $completedSet[[string]$item] = $true
}

$pending = @(
    $state.codes | Where-Object { -not $completedSet.ContainsKey([string]$_) }
)

Write-Host ""
Write-Host "Worker: $WorkerBaseUrl"
Write-Host "Eligible stocks: $($state.eligibleCount)"
Write-Host "Already completed: $($state.completed.Count)"
Write-Host "Remaining: $($pending.Count)"
Write-Host "Maximum stocks this run: $MaxStocksPerRun"
Write-Host "Read-only validation. No D1 writes are performed."
Write-Host ""

if ($pending.Count -eq 0) {
    Write-Host "All eligible stocks have already been processed." -ForegroundColor Green
}
else {
    $runCount = [Math]::Min($MaxStocksPerRun, $pending.Count)
    $stopForError = $false

    for ($i = 0; $i -lt $runCount; $i++) {
        $code = [string]$pending[$i]
        Write-Host "[$($i + 1)/$runCount] Validating $code ..." -ForegroundColor Yellow

        # Capture Write-Host output from the existing, independently tested validator.
        $output = @(& $BaseScriptPath -WorkerBaseUrl $WorkerBaseUrl -Codes @($code) 6>&1 | Out-String)
        $outputText = $output -join "`n"
        Write-Host $outputText

        $status = "UNKNOWN"
        if ($outputText -match '(?m)^\s*PASS\s*\|') {
            $status = "PASS"
        }
        elseif ($outputText -match '(?m)^\s*CHECK\s*\|') {
            $status = "CHECK"
        }
        elseif ($outputText -match '(?m)^\s*ERROR\s*\|') {
            $status = "ERROR"
        }

        $isQuotaError = $outputText -match 'D1_ERROR|daily row read limit|row read limit'
        if ($status -eq "PASS" -or $status -eq "CHECK") {
            $state.completed = @($state.completed) + @($code)
            $state.results = @($state.results) + @([pscustomobject]@{
                code = $code
                status = $status
                checkedAt = (Get-Date).ToString("o")
                output = $outputText.Trim()
            })
        }
        else {
            # ERROR/UNKNOWN is deliberately not marked complete; it will be retried next run.
            $state.results = @($state.results) + @([pscustomobject]@{
                code = $code
                status = $status
                checkedAt = (Get-Date).ToString("o")
                output = $outputText.Trim()
            })
            $stopForError = $true
        }

        $state.updatedAt = (Get-Date).ToString("o")
        $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ProgressFile -Encoding UTF8

        if ($stopForError) {
            if ($isQuotaError) {
                Write-Warning "D1 daily read quota appears exhausted. Stopping now; this code remains pending and will be retried next run."
            }
            else {
                Write-Warning "Validation did not produce PASS/CHECK. Stopping to avoid hiding an error; this code remains pending."
            }
            break
        }
    }
}

$doneCount = @($state.completed).Count
$remainingCount = $state.eligibleCount - $doneCount
$passCount = @($state.results | Where-Object { $_.status -eq "PASS" }).Count
$checkCount = @($state.results | Where-Object { $_.status -eq "CHECK" }).Count
$errorCount = @($state.results | Where-Object { $_.status -eq "ERROR" -or $_.status -eq "UNKNOWN" }).Count

Write-Host ""
Write-Host "========== CHECKPOINT SUMMARY ==========" -ForegroundColor Cyan
Write-Host "Completed (PASS/CHECK): $doneCount / $($state.eligibleCount)"
Write-Host "PASS: $passCount"
Write-Host "CHECK: $checkCount"
Write-Host "ERROR/UNKNOWN attempts: $errorCount"
Write-Host "Remaining: $remainingCount"
Write-Host "Progress saved to: $ProgressFile" -ForegroundColor Green

# Export a compact CSV report alongside the JSON checkpoint.
$csvPath = [System.IO.Path]::ChangeExtension($ProgressFile, ".csv")
$state.results |
    Select-Object code, status, checkedAt |
    Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8

Write-Host "CSV report: $csvPath"
if ($remainingCount -gt 0) {
    Write-Host "Run this same command again after the D1 quota resets to continue. Completed codes will be skipped."
}
else {
    Write-Host "All eligible stocks have been validated. Review CHECK entries, if any." -ForegroundColor Green
}

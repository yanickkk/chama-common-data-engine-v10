param(
    [Parameter(Mandatory = $true)]
    [string]$WorkerBaseUrl,

    [string[]]$Codes = @('000810', '000105', '000120', '000140', '000850', '001570'),

    [double]$AbsoluteTolerance = 0.000001,
    [double]$RelativeTolerance = 0.000000001
)

$ErrorActionPreference = 'Stop'
$base = $WorkerBaseUrl.Trim().TrimEnd('/')

function Get-FieldValue {
    param($Object, [string]$Name)

    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-NumberOrNull {
    param($Object, [string]$Name)

    $value = Get-FieldValue -Object $Object -Name $Name
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
        return $null
    }

    return [double]$value
}

function New-EMA {
    param([double[]]$Values, [int]$Period)

    $out = New-Object 'object[]' $Values.Length
    if ($Values.Length -lt $Period) { return ,$out }

    $sum = 0.0
    for ($i = 0; $i -lt $Period; $i++) {
        $sum += $Values[$i]
    }

    $current = $sum / $Period
    $out[$Period - 1] = $current
    $k = 2.0 / ($Period + 1.0)

    for ($i = $Period; $i -lt $Values.Length; $i++) {
        $current = $Values[$i] * $k + $current * (1.0 - $k)
        $out[$i] = $current
    }

    return ,$out
}

function New-WilderRSI {
    param([double[]]$Values, [int]$Period = 14)

    $out = New-Object 'object[]' $Values.Length
    if ($Values.Length -le $Period) { return ,$out }

    $gain = 0.0
    $loss = 0.0

    for ($i = 1; $i -le $Period; $i++) {
        $delta = $Values[$i] - $Values[$i - 1]
        if ($delta -gt 0) {
            $gain += $delta
        }
        else {
            $loss += -$delta
        }
    }

    $avgGain = $gain / $Period
    $avgLoss = $loss / $Period

    if ($avgGain -eq 0.0 -and $avgLoss -eq 0.0) {
        $out[$Period] = 50.0
    }
    elseif ($avgLoss -eq 0.0) {
        $out[$Period] = 100.0
    }
    elseif ($avgGain -eq 0.0) {
        $out[$Period] = 0.0
    }
    else {
        $out[$Period] = 100.0 - 100.0 / (1.0 + $avgGain / $avgLoss)
    }

    for ($i = $Period + 1; $i -lt $Values.Length; $i++) {
        $delta = $Values[$i] - $Values[$i - 1]
        $up = [math]::Max($delta, 0.0)
        $down = [math]::Max(-$delta, 0.0)

        $avgGain = ($avgGain * ($Period - 1) + $up) / $Period
        $avgLoss = ($avgLoss * ($Period - 1) + $down) / $Period

        if ($avgGain -eq 0.0 -and $avgLoss -eq 0.0) {
            $out[$i] = 50.0
        }
        elseif ($avgLoss -eq 0.0) {
            $out[$i] = 100.0
        }
        elseif ($avgGain -eq 0.0) {
            $out[$i] = 0.0
        }
        else {
            $out[$i] = 100.0 - 100.0 / (1.0 + $avgGain / $avgLoss)
        }
    }

    return ,$out
}

function Compare-Value {
    param(
        $Expected,
        $Actual,
        [string]$Field,
        [string]$Date,
        [string]$Code
    )

    if ($null -eq $Expected -and $null -eq $Actual) { return $null }

    if (($null -eq $Expected) -xor ($null -eq $Actual)) {
        return [pscustomobject]@{
            code = $Code
            date = $Date
            field = $Field
            expected = $Expected
            actual = $Actual
            difference = $null
            reason = 'NULL mismatch'
        }
    }

    $e = [double]$Expected
    $a = [double]$Actual
    $diff = [math]::Abs($e - $a)
    $limit = [math]::Max($AbsoluteTolerance, [math]::Abs($e) * $RelativeTolerance)

    if ($diff -gt $limit) {
        return [pscustomobject]@{
            code = $Code
            date = $Date
            field = $Field
            expected = $e
            actual = $a
            difference = $diff
            allowed = $limit
            reason = 'Tolerance exceeded'
        }
    }

    return $null
}

Write-Host "Worker: $base" -ForegroundColor Cyan
Write-Host "Codes: $($Codes -join ', ')" -ForegroundColor Cyan
Write-Host 'Read-only validation. No database writes will be performed.' -ForegroundColor Green

$allResults = New-Object System.Collections.Generic.List[object]
$allMismatches = New-Object System.Collections.Generic.List[object]

foreach ($rawCode in $Codes) {
    $code = ([string]$rawCode).Trim().PadLeft(6, '0')
    Write-Host "`n[$code] Fetching data and recalculating indicators..." -ForegroundColor Yellow

    try {
        $candleUri = "$base/api/data/candles?code=$code&limit=2500"
        $indicatorUri = "$base/api/data/indicators?code=$code&limit=2500"

        $candleResponse = Invoke-RestMethod -Uri $candleUri -Method Get -TimeoutSec 90
        $indicatorResponse = Invoke-RestMethod -Uri $indicatorUri -Method Get -TimeoutSec 90

        if (-not $candleResponse.ok -or -not $indicatorResponse.ok) {
            throw 'Worker API returned ok=false.'
        }

        $candleMap = @{}
        foreach ($row in @($candleResponse.rows)) {
            $date = [string](Get-FieldValue $row 'date')
            $close = Get-NumberOrNull $row 'close'

            if ($date -match '^\d{8}$' -and $null -ne $close -and $close -gt 0) {
                $candleMap[$date] = $row
            }
        }

        $candles = @(
            $candleMap.Values |
                Sort-Object { [string](Get-FieldValue $_ 'date') }
        )

        if ($candles.Count -lt 120) {
            throw "Only $($candles.Count) candles found; at least 120 are required."
        }

        $indicatorMap = @{}
        foreach ($row in @($indicatorResponse.rows)) {
            $date = [string](Get-FieldValue $row 'date')
            if ($date -match '^\d{8}$') {
                $indicatorMap[$date] = $row
            }
        }

        [double[]]$closes = @(
            $candles | ForEach-Object {
                [double](Get-FieldValue $_ 'close')
            }
        )

        $ema5 = New-EMA -Values $closes -Period 5
        $ema10 = New-EMA -Values $closes -Period 10
        $ema20 = New-EMA -Values $closes -Period 20
        $ema60 = New-EMA -Values $closes -Period 60
        $ema120 = New-EMA -Values $closes -Period 120
        $rsi14 = New-WilderRSI -Values $closes -Period 14
        $ema12 = New-EMA -Values $closes -Period 12
        $ema26 = New-EMA -Values $closes -Period 26

        $macd = New-Object 'object[]' $closes.Length
        $macdSignal = New-Object 'object[]' $closes.Length
        $macdHist = New-Object 'object[]' $closes.Length
        $validMacdIndices = New-Object System.Collections.Generic.List[int]

        for ($i = 0; $i -lt $closes.Length; $i++) {
            if ($null -ne $ema12[$i] -and $null -ne $ema26[$i]) {
                $macd[$i] = [double]$ema12[$i] - [double]$ema26[$i]
                $validMacdIndices.Add($i)
            }
        }

        if ($validMacdIndices.Count -ge 9) {
            $signal = 0.0

            for ($j = 0; $j -lt 9; $j++) {
                $signal += [double]$macd[$validMacdIndices[$j]]
            }

            $signal /= 9.0
            $seedIndex = $validMacdIndices[8]
            $macdSignal[$seedIndex] = $signal
            $macdHist[$seedIndex] = [double]$macd[$seedIndex] - $signal
            $signalK = 2.0 / 10.0

            for ($j = 9; $j -lt $validMacdIndices.Count; $j++) {
                $idx = $validMacdIndices[$j]
                $signal = [double]$macd[$idx] * $signalK + $signal * (1.0 - $signalK)
                $macdSignal[$idx] = $signal
                $macdHist[$idx] = [double]$macd[$idx] - $signal
            }
        }

        $fields = @(
            @{ actual = 'ema5'; expected = $ema5 },
            @{ actual = 'ema10'; expected = $ema10 },
            @{ actual = 'ema20'; expected = $ema20 },
            @{ actual = 'ema60'; expected = $ema60 },
            @{ actual = 'ema120'; expected = $ema120 },
            @{ actual = 'rsi14'; expected = $rsi14 },
            @{ actual = 'macd'; expected = $macd },
            @{ actual = 'macd_signal'; expected = $macdSignal },
            @{ actual = 'macd_hist'; expected = $macdHist }
        )

        $checkedCells = 0
        $missingDates = 0
        $extraDates = 0

        foreach ($date in $candleMap.Keys) {
            if (-not $indicatorMap.ContainsKey($date)) { $missingDates++ }
        }

        foreach ($date in $indicatorMap.Keys) {
            if (-not $candleMap.ContainsKey($date)) { $extraDates++ }
        }

        for ($i = 0; $i -lt $candles.Count; $i++) {
            $date = [string](Get-FieldValue $candles[$i] 'date')
            if (-not $indicatorMap.ContainsKey($date)) { continue }

            $actualRow = $indicatorMap[$date]

            foreach ($field in $fields) {
                $checkedCells++
                $expectedValue = $field.expected[$i]
                $actualValue = Get-NumberOrNull $actualRow $field.actual

                $mismatch = Compare-Value `
                    -Expected $expectedValue `
                    -Actual $actualValue `
                    -Field $field.actual `
                    -Date $date `
                    -Code $code

                if ($null -ne $mismatch) {
                    $allMismatches.Add($mismatch)
                }
            }
        }

        $codeMismatchCount = @(
            $allMismatches | Where-Object { $_.code -eq $code }
        ).Count

        $latestCandleDate = [string](Get-FieldValue $candles[-1] 'date')
        $latestIndicatorDate = $null
        if ($indicatorMap.ContainsKey($latestCandleDate)) {
            $latestIndicatorDate = $latestCandleDate
        }

        $result = [pscustomobject]@{
            code = $code
            candles = $candles.Count
            indicatorRows = $indicatorMap.Count
            checkedCells = $checkedCells
            missingIndicatorDates = $missingDates
            extraIndicatorDates = $extraDates
            mismatchCount = $codeMismatchCount
            latestCandleDate = $latestCandleDate
            latestIndicatorDate = $latestIndicatorDate
        }

        $allResults.Add($result)

        if ($codeMismatchCount -eq 0 -and $missingDates -eq 0 -and $extraDates -eq 0) {
            Write-Host "  PASS | candles=$($result.candles) | indicators=$($result.indicatorRows) | cells=$checkedCells | mismatches=0" -ForegroundColor Green
        }
        else {
            Write-Host "  CHECK | missingDates=$missingDates | extraDates=$extraDates | mismatches=$codeMismatchCount" -ForegroundColor Red
        }
    }
    catch {
        Write-Host "  ERROR | $($_.Exception.Message)" -ForegroundColor Red
        $allResults.Add([pscustomobject]@{
            code = $code
            error = $_.Exception.Message
        })
    }
}

Write-Host "`n========== FINAL SUMMARY ==========" -ForegroundColor Cyan
$allResults | Format-Table -AutoSize

if ($allMismatches.Count -gt 0) {
    Write-Host "`nMISMATCH DETAILS (first 30):" -ForegroundColor Red
    $allMismatches | Select-Object -First 30 | Format-Table -AutoSize
}

$failed = @(
    $allResults | Where-Object {
        $_.error -or
        $_.mismatchCount -gt 0 -or
        $_.missingIndicatorDates -gt 0 -or
        $_.extraIndicatorDates -gt 0
    }
).Count

if ($failed -eq 0 -and $allResults.Count -gt 0) {
    Write-Host "`nValidation passed for all selected codes." -ForegroundColor Green
}
else {
    Write-Host "`nValidation needs review. Check errors or mismatches above." -ForegroundColor Red
}

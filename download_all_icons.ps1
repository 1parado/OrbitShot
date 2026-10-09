$json = Get-Content "E:\screen_extention\all_logos.json" -Raw | ConvertFrom-Json

$storageBase = "https://ngccgynpmxypswzjxnpx.supabase.co/storage/v1/object/public/logo-submissions/"
$iconDir = "E:\screen_extention\icon"

if (-not (Test-Path $iconDir)) {
    New-Item -ItemType Directory -Path $iconDir | Out-Null
}

# Deduplicate: for each company name, prefer logomark > logo > logotype
$logoMap = @{}
$priority = @{ "logomark" = 3; "logo" = 2; "logotype" = 1 }

foreach ($item in $json) {
    $name = $item.name
    $type = $item.logo_type
    if (-not $name -or -not $item.light_mode_file_path) { continue }

    $p = if ($priority.ContainsKey($type)) { $priority[$type] } else { 0 }

    if (-not $logoMap.ContainsKey($name) -or $p -gt $logoMap[$name].Priority) {
        $logoMap[$name] = [PSCustomObject]@{
            Name = $name
            FilePath = $item.light_mode_file_path
            LogoType = $type
            Priority = $p
        }
    }
}

$companies = $logoMap.Values | Sort-Object Name
$total = $companies.Count
Write-Host "Total unique companies: $total"
Write-Host "Starting downloads..."
Write-Host ""

$success = 0
$failed = 0
$failedList = @()

for ($i = 0; $i -lt $total; $i++) {
    $company = $companies[$i]
    $name = $company.Name

    # Create a safe filename from company name
    $safeName = $name -replace '[\\/:*?"<>|]', '-'
    $safeName = $safeName -replace '\s+', '-'
    $safeName = $safeName -replace '-+', '-'
    $safeName = $safeName.Trim('-').ToLower()

    $filePath = $company.FilePath
    $ext = if ($filePath -like "*.svg") { ".svg" } elseif ($filePath -like "*.png") { ".png" } else { ".svg" }
    $outputFile = "$iconDir\$safeName$ext"

    $fullUrl = "${storageBase}${filePath}"

    try {
        $output = curl.exe -s -o "$outputFile" "$fullUrl" 2>&1
        if (Test-Path $outputFile) {
            $fileSize = (Get-Item $outputFile).Length
            if ($fileSize -gt 0) {
                $success++
                if (($i + 1) % 20 -eq 0 -or $i -eq 0 -or $i -eq $total - 1) {
                    Write-Host "[$($i+1)/$total] OK: $name -> $safeName$ext ($fileSize bytes)"
                }
            } else {
                $failed++
                $failedList += $name
                Write-Host "[$($i+1)/$total] EMPTY: $name"
            }
        } else {
            $failed++
            $failedList += $name
            Write-Host "[$($i+1)/$total] FAIL: $name"
        }
    } catch {
        $failed++
        $failedList += $name
        Write-Host "[$($i+1)/$total] ERROR: $name - $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "===== SUMMARY ====="
Write-Host "Total companies: $total"
Write-Host "Downloaded: $success"
Write-Host "Failed: $failed"
if ($failedList.Count -gt 0) {
    Write-Host "Failed: $($failedList -join ', ')"
}

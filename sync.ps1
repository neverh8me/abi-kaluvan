# Синхронізація спільної бази покупок (library/purchases.json) при запуску, одразу після перевірки оновлень.
#  - кожен: база з GitHub (прод) зливається з локальною (туди сайт пише свої покупки);
#  - гравець: свої нові покупки анонімно йдуть у Google Форму (без ніка — його в записах нема);
#  - автор (папка — git-клон): забирає записи з таблиці форми, перевіряє й вливає в базу,
#    а сервер потім сам комітить і пушить її на GitHub.
param([string]$Root = $PSScriptRoot)

$BASE_REMOTE = 'https://raw.githubusercontent.com/neverh8me/abi-kaluvan/main/library/purchases.json'
$FORM_POST   = 'https://docs.google.com/forms/d/e/1FAIpQLScEQr6lGVb0-fzTCv2SwBMrOyQqU-vlUyQY1zf_exOF9479RQ/formResponse'
$FORM_FIELD  = 'entry.1614546192'
$SHEET_CSV   = 'https://docs.google.com/spreadsheets/d/1bUAUAnvev5xRf14e0uN9IHA23ZjtnKm2ywkb7pNIseg/export?format=csv&gid=1589502385' # таблиця відповідей форми (має бути відкрита за посиланням)
$BATCH       = 25   # стільки покупок в одній відповіді форми
$UA          = 'abi-kaluvan-sync'

$baseFile = Join-Path $Root 'library\purchases.json'
$sentFile = Join-Path $Root '.purchases-sent.json'
$isAuthor = Test-Path (Join-Path $Root '.git')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Key($e) { "$($e.t)|$($e.itemId)|$($e.price)" }

# Текст відповіді завжди як UTF-8 (Windows PowerShell інакше вгадує кодування або віддає байти)
function Fetch([string]$url, [int]$timeout) {
  $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec $timeout -UserAgent $UA
  return [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
}

function ReadList([string]$json) {
  try { $d = $json | ConvertFrom-Json } catch { return @() }
  if ($d -and $d.purchases) { return @($d.purchases) }
  if ($d -is [array]) { return @($d) }
  return @()
}

# Дозволені пари «звук → предмет» — так само, як їх будує library.js
function ValidPairs {
  $g = Get-Content (Join-Path $Root 'library\groups.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $m = Get-Content (Join-Path $Root 'library\merchant.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $pairs = @{}
  $script:names = @{}
  foreach ($it in $m.items) { $script:names["$($it.id)"] = [string]$it.en }
  foreach ($grp in $g.groups) {
    foreach ($it in $grp.items) { if ($it.id -and -not $script:names.ContainsKey("$($it.id)")) { $script:names["$($it.id)"] = [string]$it.en } }
    $up = @($grp.events | Where-Object { $_ -match '_Up$' })[0]
    if (-not $up) { $up = $grp.events[0] }
    $sid = 'lib:' + $grp.id
    foreach ($it in $m.items) { if ($it.sound -eq $up) { $pairs["$sid|$($it.id)"] = $true } }
    foreach ($it in $grp.items) { if ($it.id) { $pairs["$sid|$($it.id)"] = $true } }
  }
  return $pairs
}

# Лише відомі поля з правдоподібними значеннями; інше (сміття, спам) відкидаємо
$QS = 'red', 'gold', 'purple', 'blue', 'green', 'white', ''
# написи вантажів, як їх записує сайт (MYSTERY_TIERS у index.html і LABELS у ocr.js)
$LABELS = '', 'Mystery Cargo', 'Uncommon Mystery Cargo', 'Rare Mystery Cargo', 'Military Items', 'Medical Supplies',
  'Computer Parts', 'Collectibles', 'Instruments', 'Energy Items', 'Household Items', 'Building Materials',
  'Electronics', 'Flammables', 'Tools', 'Paper'
function Clean($e, $pairs) {
  if (-not $e) { return $null }
  try { $t = [double]$e.t; $price = [double]$e.price } catch { return $null }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($t -lt 1735689600000 -or $t -gt $now + 86400000) { return $null }   # з 2025 року й не з майбутнього
  if ($price -ne 0 -and ($price -lt 1000 -or $price -gt 10000000)) { return $null }
  if (-not $e.soundId -or $null -eq $e.itemId -or -not $pairs.ContainsKey("$($e.soundId)|$($e.itemId)")) { return $null }
  $size = [string]$e.size
  if ($size -and $size -notmatch '^[1-9]x[1-9]$') { return $null }
  $q = [string]$e.q
  if ($QS -notcontains $q) { return $null }
  # Жодного вільного тексту в спільній базі (щоб туди ніяк не потрапив нік чи інше з екрана):
  # назва предмета — з довідника за id, напис вантажу — лише з відомого списку
  $label = [string]$e.label
  if ($LABELS -notcontains $label) { $label = '' }
  return [ordered]@{ t = [long]$t; soundId = [string]$e.soundId; size = $size; label = $label; price = [long]$price; itemId = [long]$e.itemId; item = $script:names["$($e.itemId)"]; q = $q }
}

function Merge([object[]]$lists) {
  $map = [ordered]@{}
  foreach ($list in $lists) { foreach ($e in $list) { if ($e -and $e.t) { $map[(Key $e)] = $e } } }
  return @($map.Values | Sort-Object { [double]$_.t })
}

try {
  $pairs = ValidPairs
  $local = if (Test-Path $baseFile) { ReadList (Get-Content $baseFile -Raw -Encoding UTF8) } else { @() }
  $remote = @()
  $online = $true
  try { $remote = ReadList (Fetch $BASE_REMOTE 6) }
  catch {
    # 404 — бази на GitHub ще нема (інтернет є); інше — офлайн
    $resp = $_.Exception.Response
    if (-not ($resp -and [int]$resp.StatusCode -eq 404)) { $online = $false }
  }
  $incoming = @()

  if ($isAuthor -and $SHEET_CSV -and $online) {
    # записи гравців із таблиці форми: у кожному рядку — JSON зі списком покупок
    try {
      $csv = Fetch $SHEET_CSV 8
      foreach ($row in ($csv | ConvertFrom-Csv)) {
        $cell = @($row.PSObject.Properties.Value)[1]
        foreach ($e in (ReadList $cell)) { $c = Clean $e $pairs; if ($c) { $incoming += [pscustomobject]$c } }
      }
    } catch { Write-Host "Таблицю покупок гравців не вдалося прочитати: $($_.Exception.Message)" -ForegroundColor DarkYellow }
  }

  # у спільну базу — лише очищені записи (і свої теж: там може бути розпізнаний з екрана текст)
  $cleanAll = { param($list) @($list | ForEach-Object { Clean $_ $pairs } | Where-Object { $_ } | ForEach-Object { [pscustomobject]$_ }) }
  $merged = @(Merge @(@(& $cleanAll $remote), @(& $cleanAll $local), $incoming))
  $remoteKeys = @{}; foreach ($e in $remote) { $remoteKeys[(Key $e)] = $true }
  $localKeys = @{}; foreach ($e in $local) { $localKeys[(Key $e)] = $true }
  $added = @($merged | Where-Object { -not $localKeys.ContainsKey((Key $_)) }).Count

  if (-not $isAuthor -and $online) {
    # свої нові покупки — у форму; що вже відправили або вже є на GitHub, вдруге не шлемо
    $sent = @{}
    if (Test-Path $sentFile) { foreach ($k in (Get-Content $sentFile -Raw | ConvertFrom-Json)) { $sent[$k] = $true } }
    foreach ($k in $remoteKeys.Keys) { $sent[$k] = $true }
    $todo = @($local | Where-Object { -not $sent.ContainsKey((Key $_)) } | ForEach-Object { Clean $_ $pairs } | Where-Object { $_ })
    $done = 0
    for ($i = 0; $i -lt $todo.Count; $i += $BATCH) {
      $chunk = @($todo[$i..([Math]::Min($i + $BATCH, $todo.Count) - 1)])
      $json = ConvertTo-Json -InputObject $chunk -Depth 3 -Compress
      try {
        Invoke-WebRequest $FORM_POST -Method Post -Body @{ $FORM_FIELD = $json } -UseBasicParsing -TimeoutSec 8 -UserAgent $UA | Out-Null
        foreach ($e in $chunk) { $sent[(Key $e)] = $true }
        $done += $chunk.Count
      } catch { break }
    }
    [IO.File]::WriteAllText($sentFile, (ConvertTo-Json -InputObject @($sent.Keys) -Compress), (New-Object Text.UTF8Encoding($false)))
    if ($done) { Write-Host "Твої покупки ($done) відправлено в спільну базу." -ForegroundColor Green }
  }

  if ($added -gt 0 -or $merged.Count -ne $local.Count) {
    $out = [ordered]@{ updated = [DateTime]::UtcNow.ToString('o'); purchases = @($merged) }
    [IO.File]::WriteAllText($baseFile, (ConvertTo-Json -InputObject $out -Depth 4), (New-Object Text.UTF8Encoding($false)))
  }
  $fresh = @($incoming | Where-Object { -not $localKeys.ContainsKey((Key $_)) -and -not $remoteKeys.ContainsKey((Key $_)) }).Count
  $from = if ($fresh) { ", нових від гравців: $fresh" } else { '' }
  Write-Host "Спільна база покупок: $($merged.Count)$from." -ForegroundColor DarkGray
} catch {
  Write-Host "Синхронізація бази покупок не вдалася: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

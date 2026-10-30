# Sync of the shared purchase base (library/purchases.json) on launch, right after the update check:
#  - the GitHub base is merged with the local one (the site writes your purchases locally);
#  - your new purchases go to the shared-base server (a Cloudflare Worker, code in worker/worker.js).
#    It validates them and appends them to the base on GitHub; only it has the GitHub token, nothing secret here.
param([string]$Root = $PSScriptRoot)

$BASE_REMOTE = 'https://raw.githubusercontent.com/neverh8me/abi-merchant-helper/main/library/purchases.json'
$WORKER      = 'https://abi-kaluvan.kaluvan-tools.workers.dev/submit'   # shared-base server (worker/worker.js)
$BATCH       = 25   # purchases per request (the Worker accepts no more)
$UA          = 'abi-merchant-helper-sync'

$baseFile = Join-Path $Root 'library\purchases.json'
$mineFile = Join-Path $Root 'purchases.mine.json'   # own purchases (written by the site, not in git)
$sentFile = Join-Path $Root '.purchases-sent.json'
$isClone = Test-Path (Join-Path $Root '.git')        # a git clone (the author): the base file in git is left alone, the Worker maintains it
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Key($e) { "$($e.t)|$($e.itemId)|$($e.price)" }

# Response text always as UTF-8 (Windows PowerShell otherwise guesses the encoding or returns bytes)
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

# Allowed "sound → item" pairs, built the same way as in library.js
function ValidPairs {
  $g = Get-Content (Join-Path $Root 'library\groups.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $m = Get-Content (Join-Path $Root 'library\merchant.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $pairs = @{}
  $script:names = @{}; $script:quals = @{}; $script:itemPools = @{}
  $rarity = @{ 6 = 'red'; 5 = 'gold'; 4 = 'purple'; 3 = 'blue'; 2 = 'green'; 1 = 'white' }
  foreach ($it in $m.items) { $script:names["$($it.id)"] = [string]$it.en; $script:quals["$($it.id)"] = $rarity[[int]$it.rarity] }
  # merchant pool prices where the item occurs: a real purchase costs exactly that (± discount/markup)
  foreach ($pl in $m.pools) { foreach ($pi in $pl.items) { $k = "$($pi[0])"; if (-not $script:itemPools[$k]) { $script:itemPools[$k] = @() }; $script:itemPools[$k] += [pscustomobject]@{ label = [string]$pl.label; price = [double]$pl.price } } }
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

# Only known fields with plausible values; anything else (junk, spam) is dropped
# cargo labels as the site writes them (MYSTERY_TIERS in index.html and LABELS in ocr.js)
$LABELS = '', 'Mystery Cargo', 'Uncommon Mystery Cargo', 'Rare Mystery Cargo', 'Military Items', 'Medical Supplies',
  'Computer Parts', 'Collectibles', 'Instruments', 'Energy Items', 'Household Items', 'Building Materials',
  'Electronics', 'Flammables', 'Tools', 'Paper', 'Rare Collectibles', 'Uncommon Collectibles', 'Rare Medical Supplies', 'Uncommon Military Items'
function Clean($e, $pairs) {
  if (-not $e) { return $null }
  try { $t = [double]$e.t; $price = [double]$e.price } catch { return $null }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($t -lt 1735689600000 -or $t -gt $now + 86400000) { return $null }   # from 2025 on and not from the future
  if ($null -eq $e.itemId) { return $null }
  # No free text in the shared base (so that a nickname or anything else from the screen can never get in):
  # item name from the catalog by id, cargo label only from a known list
  $label = [string]$e.label
  if ($LABELS -notcontains $label) { $label = '' }
  # with a sound: the item must be one of that sound; without (bought without dragging): the cargo label must be known
  $sid = if ($e.soundId) { [string]$e.soundId } else { $null }
  if ($sid) { if (-not $pairs.ContainsKey("$sid|$($e.itemId)")) { return $null } }
  elseif (-not $label) { return $null }
  # the price must match a pool that holds this item (of that label without a sound): ±28%, with a 10% markup
  $plausible = $false
  foreach ($pp in @($script:itemPools["$($e.itemId)"])) {
    if (-not $pp -or (-not $sid -and $pp.label -ne $label)) { continue }
    $p0 = [double]$pp.price
    if ($p0 -gt 0 -and $price -gt 0 -and [Math]::Min([Math]::Abs([Math]::Log($price / $p0)), [Math]::Abs([Math]::Log($price / ($p0 * 1.1)))) -le 0.25) { $plausible = $true; break }
  }
  if (-not $plausible) { return $null }
  $size = [string]$e.size
  if ($size -and $size -notmatch '^[1-9]x[1-9]$') { return $null }
  $q = [string]$script:quals["$($e.itemId)"]   # quality from the catalog, not from the entry
  return [ordered]@{ t = [long]$t; soundId = $sid; size = $size; label = $label; price = [long]$price; itemId = [long]$e.itemId; item = $script:names["$($e.itemId)"]; q = $q }
}

function Merge([object[]]$lists) {
  $map = [ordered]@{}
  foreach ($list in $lists) { foreach ($e in $list) { if ($e -and $e.t) { $map[(Key $e)] = $e } } }
  return @($map.Values | Sort-Object { [double]$_.t })
}

try {
  $pairs = ValidPairs
  $local = if (Test-Path $baseFile) { ReadList (Get-Content $baseFile -Raw -Encoding UTF8) } else { @() }
  $mine = if (Test-Path $mineFile) { ReadList (Get-Content $mineFile -Raw -Encoding UTF8) } else { @() }
  $remote = @()
  $online = $true
  try { $remote = ReadList (Fetch $BASE_REMOTE 6) }
  catch {
    # 404: there is no base on GitHub yet (online); anything else: offline
    $resp = $_.Exception.Response
    if (-not ($resp -and [int]$resp.StatusCode -eq 404)) { $online = $false }
  }

  # only cleaned entries go into the shared base (own ones too: they may contain text read from the screen)
  $cleanAll = { param($list) @($list | ForEach-Object { Clean $_ $pairs } | Where-Object { $_ } | ForEach-Object { [pscustomobject]$_ }) }
  $merged = @(Merge @(@(& $cleanAll $remote), @(& $cleanAll $local), @(& $cleanAll $mine)))
  $remoteKeys = @{}; foreach ($e in $remote) { $remoteKeys[(Key $e)] = $true }
  $localKeys = @{}; foreach ($e in $local) { $localKeys[(Key $e)] = $true }
  $added = @($merged | Where-Object { -not $localKeys.ContainsKey((Key $_)) }).Count

  if ($WORKER -and $online) {
    # own new purchases go to the Worker; whatever was already sent or is already on GitHub is not sent again
    $sent = @{}
    if (Test-Path $sentFile) { foreach ($k in (Get-Content $sentFile -Raw | ConvertFrom-Json)) { $sent[$k] = $true } }
    foreach ($k in $remoteKeys.Keys) { $sent[$k] = $true }
    $todo = @($mine | Where-Object { -not $sent.ContainsKey((Key $_)) } | ForEach-Object { Clean $_ $pairs } | Where-Object { $_ })
    $done = 0
    for ($i = 0; $i -lt $todo.Count; $i += $BATCH) {
      $chunk = @($todo[$i..([Math]::Min($i + $BATCH, $todo.Count) - 1)])
      $json = ConvertTo-Json -InputObject ([ordered]@{ purchases = $chunk }) -Depth 4 -Compress
      try {
        $body = [Text.Encoding]::UTF8.GetBytes($json)
        $r = Invoke-WebRequest $WORKER -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 15 -UserAgent $UA
        $reply = try { [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json } catch { $null }
        # A current Worker lists what it accepted. An older one only takes purchases with a sound: the ones
        # without stay unsent until the Worker is updated, instead of being lost.
        $ok = if ($reply -and $null -ne $reply.accepted) { $null } else { 'sound-only' }
        foreach ($e in $chunk) {
          if ($ok -eq 'sound-only' -and -not $e.soundId) { continue }
          $sent[(Key $e)] = $true
          $done++
        }
      } catch { break } # rate limit or the server is unavailable: the rest goes next time
    }
    [IO.File]::WriteAllText($sentFile, (ConvertTo-Json -InputObject @($sent.Keys) -Compress), (New-Object Text.UTF8Encoding($false)))
    if ($done) { Write-Host "Sent $done of your purchases to the shared database." -ForegroundColor Green }
  }

  if (-not $isClone -and ($added -gt 0 -or $merged.Count -ne $local.Count)) {
    $out = [ordered]@{ updated = [DateTime]::UtcNow.ToString('o'); purchases = @($merged) }
    [IO.File]::WriteAllText($baseFile, (ConvertTo-Json -InputObject $out -Depth 4), (New-Object Text.UTF8Encoding($false)))
  }
  if ($online) { Write-Host "Purchase database updated to the latest version (purchases: $($merged.Count))." -ForegroundColor Green }
  else { Write-Host "Could not reach the purchase database (offline?), using the local copy (purchases: $($merged.Count))." -ForegroundColor DarkYellow }
} catch {
  Write-Host "Purchase database sync failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

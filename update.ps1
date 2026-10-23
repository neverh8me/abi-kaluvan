# Апдейтер ABI Kaluvan: порівнює version.json з останнім релізом на GitHub і за згодою ставить новий поверх.
# Повертає $true, якщо файли оновлено (тоді server.ps1 перезапускає себе вже з новими файлами).
param([string]$Root = $PSScriptRoot)
$repo = 'neverh8me/abi-kaluvan'

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $local = (Get-Content (Join-Path $Root 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -TimeoutSec 5 -UserAgent 'abi-kaluvan-updater'
  $remote = $rel.tag_name -replace '^v', ''
  if ([version]$remote -le [version]$local) { return $false }
} catch {
  # немає інтернету чи GitHub недоступний — просто працюємо далі зі своєю версією
  return $false
}

Write-Host ''
Write-Host "Вийшла нова версія ABI Kaluvan: v$remote (у тебе v$local)." -ForegroundColor Cyan
Write-Host "Що нового: $($rel.html_url)"
$answer = Read-Host 'Оновити зараз? [Y/n]'
if ($answer -match '^(n|no|н|ні|нет)$') { return $false }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('abi-kaluvan-update-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $asset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
  $zipUrl = if ($asset) { $asset.browser_download_url } else { $rel.zipball_url }
  $zip = Join-Path $tmp 'update.zip'
  Write-Host 'Завантажую...'
  Invoke-WebRequest $zipUrl -OutFile $zip -UseBasicParsing -UserAgent 'abi-kaluvan-updater'
  Expand-Archive $zip -DestinationPath (Join-Path $tmp 'x') -Force
  # в архіві файли лежать у підпапці — шукаємо ту, де є start.bat
  $src = Get-ChildItem (Join-Path $tmp 'x') -Recurse -Filter 'start.bat' | Select-Object -First 1
  if (-not $src) { throw 'в архіві немає start.bat' }
  Copy-Item (Join-Path $src.DirectoryName '*') -Destination $Root -Recurse -Force
  Write-Host "Оновлено до v$remote." -ForegroundColor Green
  return $true
} catch {
  Write-Host "Не вдалося оновитись: $($_.Exception.Message). Працюю на старій версії." -ForegroundColor Red
  return $false
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

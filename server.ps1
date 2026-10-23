# Локальний сервер ABI Kaluvan (без встановлення нічого): роздає сайт і передає йому звук лише гри.
# Сам сервер — у helper.cs, тут лише компіляція й запуск.
param([string]$Exe = 'UAGame', [int]$Port = 8777)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$port = $Port
$url  = "http://localhost:$port/"

try {
  $probe = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $port)
  $probe.Close()
  Write-Host "Сервер уже запущено, відкриваю сторінку." -ForegroundColor Yellow
  Start-Process $url
  exit 0
} catch { }

try {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'helper.cs'), [Text.Encoding]::UTF8)) -ReferencedAssemblies System.Drawing -ErrorAction Stop
} catch {
  Write-Host "Не вдалося зібрати helper.cs: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Натисни Enter'
  exit 1
}

Write-Host "ABI Kaluvan працює: $url" -ForegroundColor Green
Write-Host "Звук беру лише з гри ($Exe.exe). Закрий це вікно, щоб зупинити."
Start-Process $url
[AbiEar.Server]::Run($PSScriptRoot, $port, $Exe)

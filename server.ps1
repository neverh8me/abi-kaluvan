# ABI: Merchant Helper local server (nothing to install): serves the site and streams to it the sound of the game only.
# The server itself is in helper.cs; this script only compiles and starts it.
param([string]$Exe = 'UAGame', [int]$Port = 8777, [switch]$NoUpdate)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$port = $Port
$url  = "http://localhost:$port/"

try {
  $probe = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $port)
  $probe.Close()
  Write-Host "ABI: Merchant Helper is already running, opening the page." -ForegroundColor Yellow
  Start-Process $url
  exit 0
} catch { }

# A new release on GitHub: update and start the already updated server.ps1
if (-not $NoUpdate -and (& (Join-Path $PSScriptRoot 'update.ps1') -Root $PSScriptRoot)) {
  & (Join-Path $PSScriptRoot 'server.ps1') -Exe $Exe -Port $Port -NoUpdate
  exit
}

# Shared purchase base: merge yours with GitHub, send your new ones to the shared base (see sync.ps1)
& (Join-Path $PSScriptRoot 'sync.ps1') -Root $PSScriptRoot

# "ABI: Merchant Helper" shortcut with the icon (a .bat cannot have an icon): in the app folder it is always kept up to date
# (the folder may have been moved), on the desktop it is created only once, so a deleted one is not brought back
try {
  $sh = New-Object -ComObject WScript.Shell
  $bat = Join-Path $PSScriptRoot 'start.bat'
  $make = {
    param($path)
    $l = $sh.CreateShortcut($path)
    $l.TargetPath = $bat; $l.WorkingDirectory = $PSScriptRoot
    $l.IconLocation = (Join-Path $PSScriptRoot 'icon.ico') + ',0'
    $l.Description = 'ABI: Merchant Helper: Field Merchant cargo helper'
    $l.Save()
  }
  # the app used to be called ABI Kaluvan: its shortcuts are renamed (the desktop one only if it is ours and still there)
  $desktop = [Environment]::GetFolderPath('Desktop')
  Remove-Item (Join-Path $PSScriptRoot 'ABI Kaluvan.lnk') -ErrorAction SilentlyContinue
  $old = Join-Path $desktop 'ABI Kaluvan.lnk'
  if ((Test-Path $old) -and $sh.CreateShortcut($old).TargetPath -eq $bat) {
    & $make (Join-Path $desktop 'ABI Merchant Helper.lnk')
    Remove-Item $old -ErrorAction SilentlyContinue
  }
  $local = Join-Path $PSScriptRoot 'ABI Merchant Helper.lnk'
  if (-not (Test-Path $local) -or $sh.CreateShortcut($local).TargetPath -ne $bat) { & $make $local }
  $marker = Join-Path $PSScriptRoot '.shortcut-done'
  if (-not (Test-Path $marker)) {
    & $make (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ABI Merchant Helper.lnk')
    Set-Content $marker '' -Encoding ASCII
    Write-Host "Created an 'ABI: Merchant Helper' shortcut on your desktop. Use it to start the app next time." -ForegroundColor Cyan
  }
} catch { }

try {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'helper.cs'), [Text.Encoding]::UTF8)) -ReferencedAssemblies System.Drawing -ErrorAction Stop
} catch {
  Write-Host "Could not build helper.cs: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host "ABI: Merchant Helper is running: $url" -ForegroundColor Green
Write-Host "Capturing sound and picture from the game only ($Exe.exe). Close this window to stop."
Start-Process $url
[AbiEar.Server]::Run($PSScriptRoot, $port, $Exe)

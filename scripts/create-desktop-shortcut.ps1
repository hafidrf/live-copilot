$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exePath = Join-Path $projectRoot "dist\win-unpacked\LiveCopilot.exe"
$iconPath = Join-Path $projectRoot "build\icon.ico"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Live Copilot.lnk"

if (-not (Test-Path $exePath)) {
  Write-Host "Executable belum ada. Jalankan dulu: npm run build:app" -ForegroundColor Yellow
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = Split-Path $exePath -Parent
$shortcut.Description = "Live Copilot - captions and interview assist"
if (Test-Path $iconPath) {
  $shortcut.IconLocation = "$iconPath,0"
} else {
  $shortcut.IconLocation = "$exePath,0"
}
$shortcut.Save()

Write-Host "Shortcut dibuat: $shortcutPath" -ForegroundColor Green

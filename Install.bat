@echo off
setlocal
title True-Shape Nesting - vipercoma
set "TRUE_SHAPE_SOURCE=%~dp0"
echo True-Shape Nesting - vipercoma
echo Close Illustrator before installing.
echo.
powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; try { function Digest($p){$sha=[Security.Cryptography.SHA256]::Create(); try{return [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($p)))}finally{$sha.Dispose()}}; $src=$env:TRUE_SHAPE_SOURCE; $dst=Join-Path $env:APPDATA 'Adobe\CEP\extensions\NestingExtension'; $files=@('CSXS\manifest.xml','index.html','css\style.css','css\design-tokens.css','css\vipercoma.css','js\CSInterface.js','js\nfp.js','js\main.js','js\dot-background.js','js\theme.js','jsx\hostscript.jsx','README.md','DESIGN.md'); foreach($f in $files){if(!(Test-Path -LiteralPath (Join-Path $src $f) -PathType Leaf)){throw ('Missing file: '+$f)}}; if(Get-Process -Name Illustrator -ErrorAction SilentlyContinue){throw 'Close Illustrator, then run Install.bat again.'}; if(Test-Path -LiteralPath $dst){$backup=Join-Path (Join-Path $env:APPDATA 'Adobe\CEP\TrueShapeNesting-backups') ('NestingExtension-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)); New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null; Copy-Item -LiteralPath $dst -Destination $backup -Recurse; Write-Host ('Backup: '+$backup)}; foreach($f in $files){$from=Join-Path $src $f; $to=Join-Path $dst $f; New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null; Copy-Item -LiteralPath $from -Destination $to -Force; if((Digest $from) -ne (Digest $to)){throw ('Verification failed: '+$f)}}; Write-Host 'Installed and verified.'; Write-Host ('Location: '+$dst); Write-Host 'Open Illustrator: Window > Extensions > True-Shape Nesting.'; Write-Host 'Unsigned CEP panels require the matching runtime debug setting.'; Write-Host 'No security settings were changed.'; exit 0 } catch { Write-Host ('INSTALL FAILED: '+$_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
  echo.
  echo Installation failed. Read the message above, correct the issue and try again.
  pause
  exit /b 1
)
echo.
pause
exit /b 0

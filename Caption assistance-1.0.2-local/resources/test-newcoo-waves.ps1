# test-newcoo-waves.ps1 (run elevated) -- stop Waves MaxxAudio, make NewCoo the default, run the
# WinRT reader on it for 8s, and dump what it produced. Tells us if Waves is what cancels the session.
$ErrorActionPreference = 'SilentlyContinue'
$res = Join-Path $env:TEMP 'ca-newcoo-test.txt'
"(running)" | Out-File $res -Encoding utf8
foreach ($s in 'WavesSysSvc64', 'WavesSvc64', 'WavesAudioService') { Stop-Service $s -Force }
Start-Sleep -Milliseconds 700
& powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Caption assistance\set-default-mic.ps1" -Id "{0.0.1.00000000}.{7cb7656a-5cca-470b-b543-7d6e66fcecd2}" | Out-Null
Start-Sleep -Milliseconds 500
$out = Join-Path $env:TEMP 'ca-newcoo-mr.out'
$p = Start-Process -FilePath "D:\Caption assistance\mic-reader.exe" -ArgumentList "0" -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError (Join-Path $env:TEMP 'ca-newcoo-mr.err')
Start-Sleep -Seconds 8
try { Stop-Process -Id $p.Id -Force } catch {}
Start-Sleep -Milliseconds 300
Get-Content $out | Out-File $res -Encoding utf8

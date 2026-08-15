# build-dist.ps1 -- build the member-distribution set: one exe per ID 0..5, each with its ID stamped
# into dist-id.json (baked into the asar, reported by the startup beacon). Output:
#   dist-build\Caption assistance-<ver>\dist-0\Caption assistance-<ver>.zip ... dist-5\...
param(
  [string]$Scratch = "C:\Users\Adam\AppData\Local\Temp\claude\d---bbb-market-analysis-center\10a3d3a5-2f4d-4c9c-97c5-561bc0e55b79\scratchpad",
  [int]$First = 0,
  [int]$Last = 5
)
Set-Location "D:\Caption assistance"
$env:ELECTRON_RUN_AS_NODE = $null
$ver = (Get-Content "package.json" | ConvertFrom-Json).version
$parent = "D:\Caption assistance\dist-build\Caption assistance-$ver"
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$idFile = "D:\Caption assistance\dist-id.json"

# kill ONLY Caption assistance's own electron (never AdamJobApplier or other Electron apps)
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'D:\Caption assistance\*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "Caption assistance*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

foreach ($id in $First..$Last) {
  Write-Host "=== building dist id $id (v$ver) ==="
  [System.IO.File]::WriteAllText($idFile, '{ "id": "' + $id + '", "v": "' + $ver + '" }')   # stamp the ID into the asar
  cmd /c "node_modules\.bin\electron-builder.cmd --win portable > dist-build\_build_dist$id.log 2>&1"
  if ($LASTEXITCODE -ne 0) { Write-Host "BUILD FAILED id $id (exit $LASTEXITCODE) -- see dist-build\_build_dist$id.log"; break }
  $exe = "D:\Caption assistance\dist-build\Caption assistance-$ver.exe"
  # stage the release (exe + extension + prompts + README) in the scratchpad
  $stage = Join-Path $Scratch "pkgdist"
  if (Test-Path $stage) { cmd /c "rd /s /q `"$stage`"" | Out-Null }
  New-Item -ItemType Directory -Force -Path (Join-Path $stage "extension") | Out-Null
  Copy-Item $exe (Join-Path $stage "Caption assistance-$ver.exe") -Force
  Copy-Item "extension\*" (Join-Path $stage "extension") -Recurse -Force   # prompts NOT bundled loose -- it's inside the exe (Prompts page)
  Copy-Item (Join-Path $Scratch "README.txt") (Join-Path $stage "README.txt") -Force
  # zip in the scratchpad, then place into dist-<id> via native copy
  $tmpzip = Join-Path $Scratch "Caption assistance-$ver.zip"
  if (Test-Path $tmpzip) { Remove-Item $tmpzip -Force }
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $tmpzip -CompressionLevel Optimal -Force
  $dst = Join-Path $parent "dist-$id"
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  cmd /c "copy /Y `"$tmpzip`" `"$dst\Caption assistance-$ver.zip`"" | Out-Null
  Write-Host "  -> $dst\Caption assistance-$ver.zip"
}
# restore the dev ID so normal launches report id=dev
[System.IO.File]::WriteAllText($idFile, '{ "id": "dev", "v": "' + $ver + '" }')
Write-Host "=== DONE. Distribution set under $parent ==="
Get-ChildItem $parent -Recurse -Filter *.zip | ForEach-Object { "{0}  ({1} MB)" -f $_.FullName, [math]::Round($_.Length/1MB,1) }

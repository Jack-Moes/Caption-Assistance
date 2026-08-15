# install-local.ps1 -- one-click setup for the Local (Vosk) engine.
# Installs Vosk (Kaldi -- no onnxruntime/ctranslate2, which crash on some CPUs) + PyAudioWPatch, and
# downloads the small English model. Streams progress to stdout; ends with "DONE" or "ERROR: ...".
$ErrorActionPreference = 'Continue'
function Log($m) { Write-Output $m }

$py = $null
foreach ($c in @('C:\Python\Python312\python.exe', 'python', 'py')) {
  try { $v = & $c --version 2>&1; if ($LASTEXITCODE -eq 0) { $py = $c; break } } catch {}
}
if (-not $py) { Log 'ERROR: Python not found. Install Python 3.10-3.12 from python.org (check "Add to PATH"), then retry.'; exit 1 }
Log ("Using Python: " + $py)

Log 'Installing Vosk + PyAudioWPatch + numpy...'
& $py -m pip install vosk PyAudioWPatch numpy
if ($LASTEXITCODE -ne 0) { Log 'ERROR: pip install failed.'; exit 1 }

$models = Join-Path $PSScriptRoot 'models'
$dir = Join-Path $models 'vosk-model-small-en-us-0.15'
if (Test-Path $dir) { Log 'Vosk model already present.'; Log 'DONE'; exit 0 }

Log 'Downloading Vosk English model (~40 MB)...'
New-Item -ItemType Directory -Force $models | Out-Null
$zip = Join-Path $models 'vosk-small.zip'
try {
  Invoke-WebRequest -Uri 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip' -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $models -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
} catch { Log ('ERROR: model download failed: ' + $_); exit 1 }
if (-not (Test-Path $dir)) { Log 'ERROR: model not found after extract.'; exit 1 }
Log 'DONE'

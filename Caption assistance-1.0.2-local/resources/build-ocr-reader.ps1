# build-ocr-reader.ps1 -- compile ocr-reader.cs -> ocr-reader.exe
# Uses the C# compiler that ships with Windows (.NET Framework 4) and the OS's own WinRT metadata, so no
# Visual Studio / .NET SDK / Windows SDK is required -- same approach as build-mic-reader.ps1.
$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$fw    = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$csc   = Join-Path $fw 'csc.exe'
$winmd = Join-Path $env:SystemRoot 'System32\WinMetadata'

if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }

$refs = @(
    "/r:$winmd\Windows.Foundation.winmd",
    "/r:$winmd\Windows.Graphics.winmd",
    "/r:$winmd\Windows.Media.winmd",
    "/r:$winmd\Windows.Storage.winmd",
    "/r:$winmd\Windows.Globalization.winmd",
    "/r:$fw\System.Runtime.dll",                                  # facade: System.Attribute etc. for winmd refs
    "/r:$fw\System.Runtime.InteropServices.WindowsRuntime.dll",   # facade: WinRT delegate marshalling
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Drawing.dll'
)

& $csc /nologo /target:exe /platform:x64 "/out:$root\ocr-reader.exe" @refs "$root\ocr-reader.cs"
if ($LASTEXITCODE -ne 0) { throw "compile failed ($LASTEXITCODE)" }
"built: $root\ocr-reader.exe ({0} bytes)" -f (Get-Item "$root\ocr-reader.exe").Length

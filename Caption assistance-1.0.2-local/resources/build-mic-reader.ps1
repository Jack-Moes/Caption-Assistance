# build-mic-reader.ps1 -- compile mic-reader.cs -> mic-reader.exe
# Uses the C# compiler that ships with Windows (.NET Framework 4) and the OS's
# own WinRT metadata, so no Visual Studio / .NET SDK / Windows SDK is needed.
# Note: the System.Runtime.WindowsRuntime facade (AsTask/await on WinRT handles)
# wants the union Windows.winmd from the Windows SDK, which we don't have --
# mic-reader.cs therefore drives IAsyncOperation/IAsyncAction Completed directly.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$fw   = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$csc  = Join-Path $fw 'csc.exe'
$winmd = Join-Path $env:SystemRoot 'System32\WinMetadata'

if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }

$refs = @(
    "/r:$winmd\Windows.Media.winmd",
    "/r:$winmd\Windows.Foundation.winmd",
    "/r:$winmd\Windows.Globalization.winmd",
    "/r:$fw\System.Runtime.dll",                                  # facade: System.Attribute etc. for winmd refs
    "/r:$fw\System.Runtime.InteropServices.WindowsRuntime.dll",   # facade: EventRegistrationToken for WinRT `+=`
    '/r:System.dll',
    '/r:System.Core.dll'
)

& $csc /nologo /target:exe /platform:x64 "/out:$root\mic-reader.exe" @refs "$root\mic-reader.cs"
if ($LASTEXITCODE -ne 0) { throw "compile failed ($LASTEXITCODE)" }
"built: $root\mic-reader.exe ({0} bytes)" -f (Get-Item "$root\mic-reader.exe").Length

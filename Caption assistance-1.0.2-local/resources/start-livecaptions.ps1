# start-livecaptions.ps1 -- ensure Windows Live Captions is running, then immediately
# park it OFF-SCREEN (fast Win32 path, before the UIA reader spins up) so a fresh launch
# never flashes on-screen. The persistent caption-reader.ps1 keeps enforcing the position.

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LcStart {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
$SWP = 0x15   # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
$opFile = Join-Path $env:TEMP 'captionassistance-lcopacity.txt'

function Want-Hidden {
    # start hides LC by default (opacity 0); honor a >0 value if the user set one
    try {
        if (Test-Path $opFile) {
            $r = (Get-Content $opFile -Raw)
            if ($r) { $a = 0; if ([int]::TryParse($r.Trim(), [ref]$a)) { return ($a -le 0) } }
        }
    } catch { }
    return $true
}
function Park-Fast {
    # move LC off-screen the instant its window handle is valid, then hold it there
    # briefly (LC re-centers itself during init) until the reader takes over enforcing
    if (-not (Want-Hidden)) { return }
    $moved = $false
    for ($i = 0; $i -lt 120; $i++) {          # up to ~3.6s of tight polling
        $lp = Get-Process LiveCaptions -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($lp -and $lp.MainWindowHandle -ne 0) {
            [LcStart]::SetWindowPos($lp.MainWindowHandle, [IntPtr]::Zero, -32000, -32000, 0, 0, $SWP) | Out-Null
            if (-not $moved) { $moved = $true; $i = 90 }   # once caught, enforce ~30 more ticks (~0.9s) then hand off
        }
        Start-Sleep -Milliseconds 30
    }
}

$p = Get-Process LiveCaptions -ErrorAction SilentlyContinue
if ($p) { Park-Fast; 'already-running'; return }

$exe = Join-Path $env:SystemRoot 'System32\LiveCaptions.exe'
if (Test-Path $exe) { try { Start-Process $exe -ErrorAction Stop } catch {} }
Park-Fast   # catch the window the moment it appears
$p = Get-Process LiveCaptions -ErrorAction SilentlyContinue
if ($p) { 'launched-exe'; return }

# fallback: toggle the OS shortcut Win + Ctrl + L, then park
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Kb { [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte scan, uint flags, UIntPtr extra); }
"@
$WIN = 0x5B; $CTRL = 0x11; $L = 0x4C; $UP = 0x2
[Kb]::keybd_event($WIN, 0, 0, [UIntPtr]::Zero)
[Kb]::keybd_event($CTRL, 0, 0, [UIntPtr]::Zero)
[Kb]::keybd_event($L, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[Kb]::keybd_event($L, 0, $UP, [UIntPtr]::Zero)
[Kb]::keybd_event($CTRL, 0, $UP, [UIntPtr]::Zero)
[Kb]::keybd_event($WIN, 0, $UP, [UIntPtr]::Zero)
Park-Fast
'sent-hotkey'

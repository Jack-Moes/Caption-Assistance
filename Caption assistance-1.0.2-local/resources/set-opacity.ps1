# set-opacity.ps1 -- restore the Windows Live Captions window: bring it back
# on-screen (if the app moved it off-screen) and set its opacity. Used on app
# close with -Alpha 255 so Live Captions is never left hidden/off-screen.
param([int]$Alpha = 255)
$p = Get-Process LiveCaptions -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p -or $p.MainWindowHandle -eq 0) { 'notfound'; exit 1 }
$h = $p.MainWindowHandle
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Op {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$SWP = 0x15
# bring back on-screen if it was parked off-screen (tolerant pos parse)
$rect = New-Object Op+RECT
if ([Op]::GetWindowRect($h, [ref]$rect) -and $rect.Left -lt -20000) {
    $px = 200; $py = 80
    $posFile = Join-Path $env:TEMP 'captionassistance-lcpos.txt'
    try { if (Test-Path $posFile) { $raw = (Get-Content $posFile -Raw); if ($raw -and ($raw.Trim() -match '^(-?\d+),(-?\d+)$')) { $px = [int]$Matches[1]; $py = [int]$Matches[2] } } } catch { }
    [Op]::SetWindowPos($h, [IntPtr]::Zero, $px, $py, 0, 0, $SWP) | Out-Null
}
$ex = [Op]::GetWindowLong($h, -20)
[Op]::SetWindowLong($h, -20, ($ex -bor 0x80000)) | Out-Null
[Op]::SetLayeredWindowAttributes($h, 0, [byte]$Alpha, 0x2) | Out-Null
"ok alpha=$Alpha"

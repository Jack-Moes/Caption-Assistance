# caption-reader.ps1 -- persistent Live Captions reader + visibility enforcer.
# Polls the Windows 11 Live Captions "CaptionsTextBlock" element via UI
# Automation every 100 ms and emits a JSON line when the text changes.
# It also enforces the user's chosen visibility from a temp state file:
#   opacity 0   -> move the window OFF-SCREEN (no alpha blink; UIA still reads it)
#   opacity >0  -> keep on-screen and apply that alpha
#   {"status":"waiting"} | {"status":"setup"} | {"status":"live","text":"..."}
# If the parent app process (arg 1) dies, it restores Live Captions on-screen and
# terminates it, so the window is never left stuck off-screen.
param([int]$ParentPid = 0)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LcOp {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$script:cap = $null
$script:lcHwnd = [IntPtr]::Zero
$last = ''
$opFile  = Join-Path $env:TEMP 'captionassistance-lcopacity.txt'
$posFile = Join-Path $env:TEMP 'captionassistance-lcpos.txt'
$SWP = 0x15   # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE

function Get-LcHwnd {
    $lp = Get-Process LiveCaptions -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($lp -and $lp.MainWindowHandle -ne 0) { return $lp.MainWindowHandle } else { return [IntPtr]::Zero }
}
function Read-Pos {   # tolerant parse of the saved on-screen position; default if empty/garbage
    $px = 200; $py = 80
    try {
        if (Test-Path $posFile) {
            $raw = (Get-Content $posFile -Raw)
            if ($raw -and ($raw.Trim() -match '^(-?\d+),(-?\d+)$')) { $px = [int]$Matches[1]; $py = [int]$Matches[2] }
        }
    } catch { }
    return @($px, $py)
}
function Find-Cap {
    $root = $AE::RootElement
    $win = $root.FindFirst($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'LiveCaptionsDesktopWindow')))
    if (-not $win) { $win = $root.FindFirst($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Live Captions'))) }
    if (-not $win) { $script:lcHwnd = [IntPtr]::Zero; return $null }
    $script:lcHwnd = Get-LcHwnd
    $el = $win.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'CaptionsTextBlock')))
    if (-not $el) {
        $texts = $win.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
        $best = $null; $bestLen = -1; $setup = $null
        foreach ($t in $texts) {
            if ($t.Current.AutomationId -eq 'SettingUpLiveCaptionsTextBlock') { $setup = $t; continue }
            $l = ($t.Current.Name).Length; if ($l -gt $bestLen) { $best = $t; $bestLen = $l }
        }
        $el = if ($best) { $best } else { $setup }
    }
    return $el
}
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Enforce-Visibility {
    if ($script:lcHwnd -eq [IntPtr]::Zero) { $script:lcHwnd = Get-LcHwnd }
    if ($script:lcHwnd -eq [IntPtr]::Zero) { return }
    if (-not (Test-Path $opFile)) { return }
    try {
        $raw = (Get-Content $opFile -Raw); if (-not $raw) { return }
        $a = 0; if (-not [int]::TryParse($raw.Trim(), [ref]$a)) { return }   # tolerate a mid-write empty/garbage read
        $rect = New-Object LcOp+RECT
        if (-not [LcOp]::GetWindowRect($script:lcHwnd, [ref]$rect)) {
            $script:lcHwnd = Get-LcHwnd   # handle went stale (LC restarted) -> refresh once
            if ($script:lcHwnd -eq [IntPtr]::Zero -or -not [LcOp]::GetWindowRect($script:lcHwnd, [ref]$rect)) { return }
        }
        $offScreen = $rect.Left -lt -20000
        if ($a -le 0) {
            if (-not $offScreen) {
                Set-Content -Path $posFile -Value "$($rect.Left),$($rect.Top)" -NoNewline -Encoding ascii
                [LcOp]::SetWindowPos($script:lcHwnd, [IntPtr]::Zero, -32000, -32000, 0, 0, $SWP) | Out-Null
            }
        } else {
            if ($offScreen) { $p = Read-Pos; [LcOp]::SetWindowPos($script:lcHwnd, [IntPtr]::Zero, $p[0], $p[1], 0, 0, $SWP) | Out-Null }
            $ex = [LcOp]::GetWindowLong($script:lcHwnd, -20)
            if (($ex -band 0x80000) -eq 0) { [LcOp]::SetWindowLong($script:lcHwnd, -20, ($ex -bor 0x80000)) | Out-Null }
            [LcOp]::SetLayeredWindowAttributes($script:lcHwnd, 0, [byte]$a, 0x2) | Out-Null
        }
    } catch { }
}
function Restore-Visibility {   # bring LC back on-screen + opaque (called before terminating it)
    if ($script:lcHwnd -eq [IntPtr]::Zero) { $script:lcHwnd = Get-LcHwnd }
    if ($script:lcHwnd -eq [IntPtr]::Zero) { return }
    try {
        $rect = New-Object LcOp+RECT
        if ([LcOp]::GetWindowRect($script:lcHwnd, [ref]$rect) -and $rect.Left -lt -20000) {
            $p = Read-Pos; [LcOp]::SetWindowPos($script:lcHwnd, [IntPtr]::Zero, $p[0], $p[1], 0, 0, $SWP) | Out-Null
        }
        [LcOp]::SetLayeredWindowAttributes($script:lcHwnd, 0, [byte]255, 0x2) | Out-Null
    } catch { }
}

# Track the parent's identity so a recycled PID can't keep us alive forever.
$parentStart = $null
if ($ParentPid -gt 0) { try { $parentStart = (Get-Process -Id $ParentPid -ErrorAction Stop).StartTime } catch { $parentStart = $null } }
$nextParentCheck = [DateTime]::UtcNow

while ($true) {
    if ($ParentPid -gt 0 -and [DateTime]::UtcNow -ge $nextParentCheck) {
        $nextParentCheck = ([DateTime]::UtcNow).AddSeconds(1)
        $pp = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
        $alive = $pp -and ((-not $parentStart) -or ($pp.StartTime -eq $parentStart))
        if (-not $alive) {
            Restore-Visibility
            try { Get-Process LiveCaptions -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
            break
        }
    }
    try {
        if (-not $script:cap) { $script:cap = Find-Cap }
        if (-not $script:cap) {
            if ($last -ne '@wait') { Emit @{ status = 'waiting' }; $last = '@wait' }
            Start-Sleep -Milliseconds 300; continue
        }
        Enforce-Visibility
        $txt = $null
        try { $txt = $script:cap.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1) }
        catch { $script:cap = $null; $script:lcHwnd = [IntPtr]::Zero; Start-Sleep -Milliseconds 150; continue }
        if ($null -eq $txt) { if ($last -ne '@wait') { Emit @{ status = 'waiting' }; $last = '@wait' } }
        elseif ($txt -eq 'Setting up live captions') { if ($last -ne '@setup') { Emit @{ status = 'setup' }; $last = '@setup' } }
        elseif ($txt -ne $last) { Emit @{ status = 'live'; text = $txt }; $last = $txt }
    } catch { }
    Start-Sleep -Milliseconds 100
}

# set-mic-exclusive.ps1 -- disable "exclusive mode" for a capture device (by endpoint GUID) and restart
# the audio stack so the change applies AND any app holding the device exclusively is released. This is
# the usual fix when the WinRT speech engine gets "UserCanceled" on a mic (another app owns it exclusively).
# MUST run elevated (writes HKLM + restarts a service). Writes a one-line result to %TEMP%\ca-exclusive-result.txt.
param([Parameter(Mandatory = $true)][string]$Guid)
$ErrorActionPreference = 'Stop'
$res = Join-Path $env:TEMP 'ca-exclusive-result.txt'
try {
  $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture\$Guid\Properties"
  if (-not (Test-Path $key)) { "ERROR: no such capture device key: $Guid" | Out-File $res -Encoding utf8; exit 1 }
  # {b3f8fa53-...},3 = allow exclusive control ; ,4 = give exclusive apps priority  -> 0 disables both
  New-ItemProperty -Path $key -Name '{b3f8fa53-0004-438e-9003-51a46e139bfc},3' -Value 0 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name '{b3f8fa53-0004-438e-9003-51a46e139bfc},4' -Value 0 -PropertyType DWord -Force | Out-Null
  Restart-Service AudioEndpointBuilder -Force   # restarts Audiosrv too; releases device holds + applies the change
  "OK: exclusive mode disabled for $Guid and audio stack restarted" | Out-File $res -Encoding utf8
} catch {
  "ERROR: $_" | Out-File $res -Encoding utf8
  exit 1
}

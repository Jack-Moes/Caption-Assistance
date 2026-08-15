# set-default-mic.ps1 -- make a capture device the Windows DEFAULT recording device (all roles), by its
# endpoint id. The WinRT SpeechRecognizer (mic-reader.exe) only ever listens to the default mic, so this
# is how we point it at the user's real microphone instead of a room/camera mic that hears the speakers.
#   -Id "{0.0.1.00000000}.{7cb7656a-...}"   ->  prints "ok" / "unknown"
param([Parameter(Mandatory = $true)][string]$Id)

$src = @'
using System;
using System.Runtime.InteropServices;
[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
    int GetMixFormat();       int GetDeviceFormat();    int ResetDeviceFormat();  int SetDeviceFormat();
    int GetProcessingPeriod();int SetProcessingPeriod();int GetShareMode();       int SetShareMode();
    int GetPropertyValue();   int SetPropertyValue();
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);   // 11th slot
    int SetEndpointVisibility();
}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient { }
public static class DefMic {
    public static void Set(string id) {
        var pc = (IPolicyConfig)(new PolicyConfigClient());
        foreach (int role in new[] { 0, 1, 2 }) { try { pc.SetDefaultEndpoint(id, role); } catch { } }   // eConsole/eMultimedia/eCommunications
    }
}
'@

try {
    try { Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop } catch { if ("$_" -notmatch 'already exists|previously') { throw } }
    [DefMic]::Set($Id)
    Write-Output 'ok'
} catch {
    [Console]::Error.WriteLine("set-default-mic failed: $_")
    Write-Output 'unknown'
    exit 1
}

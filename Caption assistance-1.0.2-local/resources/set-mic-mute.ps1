# set-mic-mute.ps1 -- mute/unmute the microphone at the system (endpoint) level via Windows Core Audio.
# An endpoint mute is seen by EVERY app (Zoom/Teams/etc). By default it targets the eConsole +
# eCommunications DEFAULT capture devices; pass -Device "<name substring>" to target a SPECIFIC mic
# (so it matches whatever device the meeting app actually uses). -State list dumps all mics as JSON.
#   -State on | off | toggle | query | list   [-Device "Microphone (NewCoo)"]
param([ValidateSet('on','off','toggle','query','list')][string]$State = 'toggle', [string]$Device = '')

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice dev);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int i, out IMMDevice dev);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int c);
    int GetAt(int i, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT val);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT val);
    int Commit();
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr n);
    int UnregisterControlChangeNotify(IntPtr n);
    int GetChannelCount(out uint c);
    int SetMasterVolumeLevel(float l, ref Guid ctx);
    int SetMasterVolumeLevelScalar(float l, ref Guid ctx);
    int GetMasterVolumeLevel(out float l);
    int GetMasterVolumeLevelScalar(out float l);
    int SetChannelVolumeLevel(uint ch, float l, ref Guid ctx);
    int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid ctx);
    int GetChannelVolumeLevel(uint ch, out float l);
    int GetChannelVolumeLevelScalar(uint ch, out float l);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)]   struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public class MicDev { public string name; public string id; public bool muted; public bool isDefault; }

public static class Mic {
    const int eCapture = 1, STATE_ACTIVE = 1, STGM_READ = 0;
    static readonly int[] Roles = new int[] { 0, 2 };   // eConsole + eCommunications
    static PROPERTYKEY PKEY_Name = MakeKey("a45c254e-df1c-4efd-8020-67d146a850e0", 14);

    static PROPERTYKEY MakeKey(string g, int pid) { PROPERTYKEY k; k.fmtid = new Guid(g); k.pid = pid; return k; }
    static IMMDeviceEnumerator En() { return (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject()); }
    static IAudioEndpointVolume Vol(IMMDevice d) {
        object o; Guid iid = typeof(IAudioEndpointVolume).GUID;
        if (d.Activate(ref iid, 1, IntPtr.Zero, out o) != 0 || o == null) return null;
        return (IAudioEndpointVolume)o;
    }
    static string NameOf(IMMDevice d) {
        IPropertyStore ps;
        if (d.OpenPropertyStore(STGM_READ, out ps) != 0 || ps == null) return "";
        PROPVARIANT pv;
        if (ps.GetValue(ref PKEY_Name, out pv) != 0) return "";
        string s = (pv.p != IntPtr.Zero) ? Marshal.PtrToStringUni(pv.p) : "";
        return s ?? "";
    }
    static HashSet<string> DefaultIds() {
        var set = new HashSet<string>(); var en = En();
        foreach (int r in Roles) { IMMDevice d; if (en.GetDefaultAudioEndpoint(eCapture, r, out d) == 0 && d != null) { string id; if (d.GetId(out id) == 0) set.Add(id); } }
        return set;
    }
    public static List<MicDev> List() {
        var res = new List<MicDev>(); var defs = DefaultIds(); var en = En();
        IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(eCapture, STATE_ACTIVE, out col) != 0 || col == null) return res;
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
            IMMDevice d; if (col.Item(i, out d) != 0 || d == null) continue;
            string id; d.GetId(out id);
            var v = Vol(d); bool m = false; if (v != null) v.GetMute(out m);
            res.Add(new MicDev { name = NameOf(d), id = id, muted = m, isDefault = defs.Contains(id) });
        }
        return res;
    }
    static List<IMMDevice> Targets(string sub) {
        // No device given -> target EVERY active capture device (guarantees the user's mic is silenced
        // even when it isn't the system default). A substring -> just the matching device(s).
        var list = new List<IMMDevice>(); var en = En();
        IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(eCapture, STATE_ACTIVE, out col) != 0 || col == null) return list;
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
            IMMDevice d; if (col.Item(i, out d) != 0 || d == null) continue;
            if (string.IsNullOrEmpty(sub) || NameOf(d).IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) list.Add(d);
        }
        return list;
    }
    public static bool AnyMuted(string sub) {
        foreach (var d in Targets(sub)) { var v = Vol(d); if (v != null) { bool m; v.GetMute(out m); if (m) return true; } }
        return false;
    }
    public static bool Set(string sub, bool mute) {
        Guid ctx = Guid.Empty; bool did = false;
        foreach (var d in Targets(sub)) { var v = Vol(d); if (v != null) { v.SetMute(mute, ref ctx); did = true; } }
        return did;
    }
}
'@

try { Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop }
catch { if ("$_" -notmatch 'already exists|previously') { [Console]::Error.WriteLine("Add-Type failed: $_"); if ($State -ne 'list') { Write-Output 'unknown' }; exit 1 } }

if ($State -eq 'list') {
    try { $items = @([Mic]::List() | ForEach-Object { [pscustomobject]@{ name = $_.name; id = $_.id; muted = $_.muted; isDefault = $_.isDefault } })
          ConvertTo-Json -InputObject $items -Compress -Depth 4 }
    catch { [Console]::Error.WriteLine("list failed: $_"); Write-Output '[]' }
    exit 0
}

try {
    switch ($State) {
        'query'  { }
        'on'     { [void][Mic]::Set($Device, $true) }
        'off'    { [void][Mic]::Set($Device, $false) }
        'toggle' { $cur = [Mic]::AnyMuted($Device); [void][Mic]::Set($Device, -not $cur) }
    }
    if ([Mic]::AnyMuted($Device)) { Write-Output 'muted' } else { Write-Output 'unmuted' }
} catch {
    [Console]::Error.WriteLine("mic op failed: $_")
    Write-Output 'unknown'
    exit 1
}

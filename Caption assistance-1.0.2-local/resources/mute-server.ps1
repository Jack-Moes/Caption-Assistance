# mute-server.ps1 -- long-lived mic-mute server. Loads the Core Audio interop ONCE, then reads commands
# from stdin (one per line) and replies on stdout, so mute/unmute is instant (no per-click C# recompile,
# which was making the button spin for seconds and drop the next click).
#   stdin  : "<state>|<device>"   state = on|off|toggle|query   device = optional name substring
#   stdout : "muted" | "unmuted" | "unknown"   (first line is "ready" once the interop is loaded)
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

public static class Mic {
    const int eCapture = 1, STATE_ACTIVE = 1;
    static PROPERTYKEY PKEY_Name = MakeKey("a45c254e-df1c-4efd-8020-67d146a850e0", 14);
    // remembers each endpoint's volume before we zeroed it, so unmute restores it (belt-and-suspenders:
    // some virtual mics ignore SetMute, so we ALSO drop the level to 0 while muted, then restore).
    static Dictionary<string,float> Saved = new Dictionary<string,float>();

    static PROPERTYKEY MakeKey(string g, int pid) { PROPERTYKEY k; k.fmtid = new Guid(g); k.pid = pid; return k; }
    static IMMDeviceEnumerator En() { return (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject()); }
    static IAudioEndpointVolume Vol(IMMDevice d) {
        object o; Guid iid = typeof(IAudioEndpointVolume).GUID;
        if (d.Activate(ref iid, 1, IntPtr.Zero, out o) != 0 || o == null) return null;
        return (IAudioEndpointVolume)o;
    }
    static string NameOf(IMMDevice d) {
        IPropertyStore ps; if (d.OpenPropertyStore(0, out ps) != 0 || ps == null) return "";
        PROPVARIANT pv; if (ps.GetValue(ref PKEY_Name, out pv) != 0) return "";
        string s = (pv.p != IntPtr.Zero) ? Marshal.PtrToStringUni(pv.p) : ""; return s ?? "";
    }
    static string IdOf(IMMDevice d) { string id; return (d.GetId(out id) == 0) ? id : ""; }
    static List<IMMDevice> Targets(string sub) {
        var list = new List<IMMDevice>(); var en = En(); IMMDeviceCollection col;
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
    public static void Set(string sub, bool mute) {
        Guid ctx = Guid.Empty;
        foreach (var d in Targets(sub)) {
            var v = Vol(d); if (v == null) continue; string id = IdOf(d);
            if (mute) {
                float cur; if (v.GetMasterVolumeLevelScalar(out cur) == 0 && cur > 0.001f) Saved[id] = cur;
                v.SetMute(true, ref ctx);
                v.SetMasterVolumeLevelScalar(0f, ref ctx);            // force silence even if SetMute is ignored
            } else {
                v.SetMute(false, ref ctx);
                float restore;
                if (Saved.TryGetValue(id, out restore)) {             // only restore mics WE zeroed (leave others' level alone)
                    v.SetMasterVolumeLevelScalar(restore < 0.02f ? 1f : restore, ref ctx);
                    Saved.Remove(id);
                }
            }
        }
    }
    // on exit, unmute + restore the level for anything we zeroed, so a closed app never leaves a silent mic
    public static void UnmuteSaved() {
        Guid ctx = Guid.Empty; var en = En(); IMMDeviceCollection col;
        if (en.EnumAudioEndpoints(eCapture, STATE_ACTIVE, out col) != 0 || col == null) { Saved.Clear(); return; }
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
            IMMDevice d; if (col.Item(i, out d) != 0 || d == null) continue; string id = IdOf(d);
            float rv; if (Saved.TryGetValue(id, out rv)) { var v = Vol(d); if (v != null) { v.SetMute(false, ref ctx); v.SetMasterVolumeLevelScalar(rv < 0.02f ? 1f : rv, ref ctx); } }
        }
        Saved.Clear();
    }
}
'@
try { Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop } catch { [Console]::Error.WriteLine("Add-Type failed: $_"); exit 1 }

[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }                 # stdin closed -> parent exited
    $line = $line.Trim(); if ($line -eq '') { continue }
    $i = $line.IndexOf('|'); if ($i -ge 0) { $state = $line.Substring(0, $i).Trim().ToLower(); $device = $line.Substring($i + 1) } else { $state = $line.ToLower(); $device = '' }
    try {
        switch ($state) {
            'on'     { [Mic]::Set($device, $true) }
            'off'    { [Mic]::Set($device, $false) }
            'toggle' { $cur = [Mic]::AnyMuted($device); [Mic]::Set($device, -not $cur) }
            'query'  { }
        }
        if ([Mic]::AnyMuted($device)) { [Console]::Out.WriteLine('muted') } else { [Console]::Out.WriteLine('unmuted') }
    } catch { [Console]::Out.WriteLine('unknown') }
    [Console]::Out.Flush()
}
try { [Mic]::UnmuteSaved() } catch {}   # parent exited (stdin closed) -> restore any volumes we zeroed

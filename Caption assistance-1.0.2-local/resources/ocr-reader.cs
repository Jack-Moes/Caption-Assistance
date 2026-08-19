// ocr-reader.cs -- capture a window and read its text with the OCR engine built into Windows.
//
// Interview coding problems live on the SCREEN, not in the audio, so the transcript can never contain
// them. This reads them directly. Windows.Media.Ocr needs no install, no API key and no network, which
// keeps the app free and offline.
//
// usage:  ocr-reader.exe [--hwnd <handle> | --file <png>]     (default: the foreground window)
// output: one JSON line -> {"ok":true,"text":"..."}  or  {"ok":false,"error":"..."}
//
// Built by build-ocr-reader.ps1 with the C# compiler and WinRT metadata that ship with Windows, exactly
// like mic-reader.exe. That toolchain has no await, so every IAsyncOperation is driven through its
// Completed handler by Await() below.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

static class Native {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}

static class Program {
    static T Await<T>(IAsyncOperation<T> op) {
        var done = new ManualResetEvent(false);
        T value = default(T);
        Exception error = null;
        op.Completed = (o, status) => {
            try {
                if (status == AsyncStatus.Completed) value = o.GetResults();
                else error = new Exception("async " + status);
            } catch (Exception e) { error = e; }
            done.Set();
        };
        done.WaitOne();
        if (error != null) throw error;
        return value;
    }

    static string CaptureToPng(IntPtr hwnd) {
        Native.RECT r;
        if (!Native.GetWindowRect(hwnd, out r)) throw new Exception("GetWindowRect failed");
        int w = r.R - r.L, h = r.B - r.T;
        if (w <= 0 || h <= 0) throw new Exception("window has no size");
        string path = Path.Combine(Path.GetTempPath(), "ca-ocr-" + Guid.NewGuid().ToString("N") + ".png");
        using (var bmp = new Bitmap(w, h)) {
            bool ok;
            using (var g = Graphics.FromImage(bmp)) {
                IntPtr dc = g.GetHdc();
                // PW_RENDERFULLCONTENT: without it, DirectComposition windows (browsers, Electron) come back blank.
                ok = Native.PrintWindow(hwnd, dc, 2);
                g.ReleaseHdc(dc);
            }
            if (!ok) {
                using (var g2 = Graphics.FromImage(bmp))
                    g2.CopyFromScreen(r.L, r.T, 0, 0, new Size(w, h));   // legacy window -> grab its screen area
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return path;
    }

    static string Recognize(string pngPath) {
        var engine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) engine = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"));
        if (engine == null) throw new Exception("no OCR language pack is installed for this user");
        StorageFile file = Await(StorageFile.GetFileFromPathAsync(pngPath));
        IRandomAccessStream stream = Await(file.OpenAsync(FileAccessMode.Read));
        BitmapDecoder decoder = Await(BitmapDecoder.CreateAsync(stream));
        SoftwareBitmap bitmap = Await(decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied));
        OcrResult result = Await(engine.RecognizeAsync(bitmap));
        var sb = new StringBuilder();
        foreach (var line in result.Lines) { sb.Append(line.Text); sb.Append('\n'); }
        bitmap.Dispose();
        stream.Dispose();
        return sb.ToString().TrimEnd();
    }

    static string Json(string s) {
        var sb = new StringBuilder("\"");
        foreach (char c in s) {
            if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') { }
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32) { sb.Append("\\u"); sb.Append(((int)c).ToString("x4")); }
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    static int Main(string[] args) {
        string png = null;
        bool temp = false;
        try {
            IntPtr hwnd = IntPtr.Zero;
            for (int i = 0; i < args.Length; i++) {
                if (args[i] == "--hwnd" && i + 1 < args.Length) hwnd = new IntPtr(long.Parse(args[++i]));
                else if (args[i] == "--file" && i + 1 < args.Length) png = args[++i];
            }
            if (png == null) {
                if (hwnd == IntPtr.Zero) hwnd = Native.GetForegroundWindow();
                if (hwnd == IntPtr.Zero || !Native.IsWindowVisible(hwnd)) throw new Exception("no visible foreground window to read");
                png = CaptureToPng(hwnd);
                temp = true;
            }
            string text = Recognize(png);
            Console.WriteLine("{\"ok\":true,\"text\":" + Json(text) + "}");
            return text.Length > 0 ? 0 : 2;
        } catch (Exception e) {
            Console.WriteLine("{\"ok\":false,\"error\":" + Json(e.Message) + "}");
            return 1;
        } finally {
            if (temp && png != null) { try { File.Delete(png); } catch { } }
        }
    }
}

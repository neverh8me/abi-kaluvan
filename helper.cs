// ABI: Merchant Helper local server: serves the site and streams to it the sound of the game process only.
// The sound is captured with the standard Windows mechanism (process loopback, as in OBS and Discord): the game
// is not opened and nobody touches it, only the process number from the regular process list is needed.
// Compiled from server.ps1 via Add-Type, so this is C# 5 (no newer language features).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AbiEar
{
    // ---------- WASAPI ----------
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    // Windows requires an "agile" handler: it may be called from any thread
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public class ActivationDone : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) { Done.Set(); }
    }

    public static class Loopback
    {
        const string VIRTUAL_DEVICE = "VAD\\Process_Loopback";
        const int ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
        const int MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
        const ushort VT_BLOB = 65;
        const int SHAREMODE_SHARED = 0;
        const uint FLAG_LOOPBACK = 0x00020000, FLAG_EVENTCALLBACK = 0x00040000;
        const uint FLAG_AUTOCONVERTPCM = 0x80000000, FLAG_SRC_DEFAULT_QUALITY = 0x08000000;
        const uint BUFFER_SILENT = 0x2;
        public const int SAMPLE_RATE = 48000;

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
        static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid riid,
            IntPtr activationParams, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation operation);

        // exe — name without .exe; "pid:1234" — a specific process (for testing without the game)
        public static int FindProcess(string exe)
        {
            int pid;
            if (exe.StartsWith("pid:") && int.TryParse(exe.Substring(4), out pid)) return Alive(pid) ? pid : 0;
            foreach (var p in Process.GetProcessesByName(exe)) return p.Id;
            return 0;
        }

        static IAudioClient Activate(int pid)
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS { type, PID, mode } in a PROPVARIANT of type VT_BLOB
            IntPtr prms = Marshal.AllocHGlobal(12), pv = Marshal.AllocHGlobal(24);
            try
            {
                Marshal.WriteInt32(prms, 0, ACTIVATION_TYPE_PROCESS_LOOPBACK);
                Marshal.WriteInt32(prms, 4, pid);
                Marshal.WriteInt32(prms, 8, MODE_INCLUDE_TARGET_PROCESS_TREE);
                for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
                Marshal.WriteInt16(pv, 0, (short)VT_BLOB);
                Marshal.WriteInt32(pv, 8, 12);
                Marshal.WriteIntPtr(pv, IntPtr.Size == 8 ? 16 : 12, prms);

                var iid = typeof(IAudioClient).GUID;
                var done = new ActivationDone();
                IActivateAudioInterfaceAsyncOperation op;
                int hr = ActivateAudioInterfaceAsync(VIRTUAL_DEVICE, ref iid, pv, done, out op);
                if (hr != 0) throw new Exception("Windows refused to capture the sound (code 0x" + hr.ToString("X8") + ")");
                if (!done.Done.WaitOne(5000)) throw new Exception("Windows did not answer the sound capture request");
                int result; object iface;
                Marshal.ThrowExceptionForHR(op.GetActivateResult(out result, out iface));
                if (result != 0) throw new Exception("Windows refused to capture the sound (code 0x" + result.ToString("X8") + ")");
                return (IAudioClient)iface;
            }
            finally { Marshal.FreeHGlobal(prms); Marshal.FreeHGlobal(pv); }
        }

        // Captures the process sound while it is alive and stop() has not returned true. onAudio — mono float 48 kHz.
        public static void Run(int pid, Action<float[]> onAudio, Func<bool> stop)
        {
            var client = Activate(pid);
            IntPtr fmt = Marshal.AllocHGlobal(18);
            try
            {
                // WAVEFORMATEX: float32, 48 kHz, stereo
                Marshal.WriteInt16(fmt, 0, 3);
                Marshal.WriteInt16(fmt, 2, 2);
                Marshal.WriteInt32(fmt, 4, SAMPLE_RATE);
                Marshal.WriteInt32(fmt, 8, SAMPLE_RATE * 8);
                Marshal.WriteInt16(fmt, 12, 8);
                Marshal.WriteInt16(fmt, 14, 32);
                Marshal.WriteInt16(fmt, 16, 0);
                Marshal.ThrowExceptionForHR(client.Initialize(SHAREMODE_SHARED,
                    FLAG_LOOPBACK | FLAG_EVENTCALLBACK | FLAG_AUTOCONVERTPCM | FLAG_SRC_DEFAULT_QUALITY, 2000000, 0, fmt, IntPtr.Zero));
            }
            finally { Marshal.FreeHGlobal(fmt); }

            var ready = new AutoResetEvent(false);
            Marshal.ThrowExceptionForHR(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()));
            var ccId = typeof(IAudioCaptureClient).GUID;
            object svc;
            Marshal.ThrowExceptionForHR(client.GetService(ref ccId, out svc));
            var capture = (IAudioCaptureClient)svc;
            Marshal.ThrowExceptionForHR(client.Start());
            var watch = Stopwatch.StartNew();
            try
            {
                float[] stereo = new float[0];
                while (!stop())
                {
                    ready.WaitOne(100);
                    if (watch.ElapsedMilliseconds > 1000)
                    {
                        watch.Restart();
                        if (!Alive(pid)) return;
                    }
                    uint packet;
                    while (capture.GetNextPacketSize(out packet) == 0 && packet > 0)
                    {
                        IntPtr data; uint frames, flags; ulong devPos, qpc;
                        Marshal.ThrowExceptionForHR(capture.GetBuffer(out data, out frames, out flags, out devPos, out qpc));
                        var mono = new float[frames];
                        if ((flags & BUFFER_SILENT) == 0 && frames > 0)
                        {
                            if (stereo.Length < frames * 2) stereo = new float[frames * 2];
                            Marshal.Copy(data, stereo, 0, (int)frames * 2);
                            for (int i = 0; i < frames; i++) mono[i] = (stereo[2 * i] + stereo[2 * i + 1]) * 0.5f;
                        }
                        capture.ReleaseBuffer(frames);
                        if (frames > 0) onAudio(mono);
                    }
                }
            }
            finally
            {
                client.Stop();
                Marshal.ReleaseComObject(capture);
                Marshal.ReleaseComObject(client);
            }
        }

        // Only a check of the process list: the game process itself is not opened (the anti-cheat would not allow it, and it is not needed)
        static bool Alive(int pid)
        {
            try { Process.GetProcessById(pid).Dispose(); return true; } catch { return false; }
        }
    }

    // ---------- screen capture ----------
    // The game window is captured with plain GDI (like a screenshot) and sent as JPEG. Works with the game in
    // "borderless window" mode; in exclusive fullscreen Windows returns a black frame, and the page is told so.
    public static class Screen
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
        // The mouse cursor on the screen (a plain system call, as any app can do); false if unknown
        public static bool Cursor(out int x, out int y) { Point p; bool ok = GetCursorPos(out p); x = p.X; y = p.Y; return ok; }
        delegate bool EnumProc(IntPtr hwnd, IntPtr param);
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }

        // The largest visible window of the game process, from the regular Windows window list; the process itself is not opened
        public static IntPtr FindWindow(int pid)
        {
            IntPtr best = IntPtr.Zero;
            long bestArea = 0;
            EnumWindows(delegate (IntPtr h, IntPtr p)
            {
                int owner;
                GetWindowThreadProcessId(h, out owner);
                if (owner != pid || !IsWindowVisible(h)) return true;
                Rect r;
                if (!GetClientRect(h, out r)) return true;
                long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
                if (area > bestArea) { bestArea = area; best = h; }
                return true;
            }, IntPtr.Zero);
            return best;
        }

        // The window client area (without border and title) in screen coordinates
        public static System.Drawing.Rectangle ClientArea(IntPtr hwnd)
        {
            Rect r;
            if (!GetClientRect(hwnd, out r)) return System.Drawing.Rectangle.Empty;
            var p = new Point();
            ClientToScreen(hwnd, ref p);
            return new System.Drawing.Rectangle(p.X, p.Y, r.Right - r.Left, r.Bottom - r.Top);
        }

        static readonly System.Drawing.Imaging.ImageCodecInfo jpeg = FindJpeg();
        static System.Drawing.Imaging.ImageCodecInfo FindJpeg()
        {
            foreach (var c in System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders())
                if (c.MimeType == "image/jpeg") return c;
            return null;
        }

        // Capture of a screen rectangle (the client area of the game window)
        public static System.Drawing.Bitmap Capture(System.Drawing.Rectangle area)
        {
            var bmp = new System.Drawing.Bitmap(area.Width, area.Height, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
            using (var g = System.Drawing.Graphics.FromImage(bmp))
                g.CopyFromScreen(area.X, area.Y, 0, 0, area.Size, System.Drawing.CopyPixelOperation.SourceCopy);
            return bmp;
        }

        // Whether the frame is completely black (game in exclusive fullscreen): 81 points in a grid
        public static bool IsBlack(System.Drawing.Bitmap bmp)
        {
            for (int i = 1; i < 10; i++)
                for (int j = 1; j < 10; j++)
                {
                    var px = bmp.GetPixel(bmp.Width * i / 10, bmp.Height * j / 10);
                    if (px.R + px.G + px.B > 30) return false;
                }
            return true;
        }

        public static byte[] Encode(System.Drawing.Bitmap bmp)
        {
            using (var ms = new MemoryStream())
            {
                var prm = new System.Drawing.Imaging.EncoderParameters(1);
                prm.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 92L);
                bmp.Save(ms, jpeg, prm);
                return ms.ToArray();
            }
        }

    }

    // ---------- server ----------
    public static class Server
    {
        static readonly List<WebSocket> clients = new List<WebSocket>();
        static readonly List<WebSocket> screenClients = new List<WebSocket>();
        const int SCREEN_FRAME_MS = 33;  // up to 30 frames per second
        const int BLACK_CHECK_EVERY = 15; // check for a black frame once per this many frames
        static string status = "{\"type\":\"status\",\"state\":\"start\"}";
        static string root;
        static int sitePort;

        static readonly Dictionary<string, string> types = new Dictionary<string, string> {
            { ".html", "text/html; charset=utf-8" }, { ".js", "application/javascript; charset=utf-8" },
            { ".css", "text/css" }, { ".json", "application/json; charset=utf-8" }, { ".png", "image/png" },
            { ".svg", "image/svg+xml" }, { ".ico", "image/x-icon" }, { ".wav", "audio/wav" },
        };

        // Blocks the thread: serves requests until the window is closed
        public static void Run(string siteRoot, int port, string exe)
        {
            root = Path.GetFullPath(siteRoot);
            sitePort = port;
            Screen.SetProcessDPIAware(); // otherwise only part of the screen is captured at 125% Windows scaling
            var listener = new HttpListener();
            listener.Prefixes.Add("http://localhost:" + port + "/");
            listener.Start();
            var t = new Thread(delegate () { CaptureLoop(exe); });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
            var s = new Thread(delegate () { ScreenLoop(exe); });
            s.IsBackground = true;
            s.Start();
            while (listener.IsListening)
            {
                var ctx = listener.GetContext();
                ThreadPool.QueueUserWorkItem(delegate { Handle(ctx); });
            }
        }

        static void Handle(HttpListenerContext ctx)
        {
            try
            {
                string path = Uri.UnescapeDataString(ctx.Request.Url.AbsolutePath);
                // Game audio, frames and the purchase file are only for our own page. Any site open in the browser
                // runs on this PC too and could connect to localhost (WebSockets are not covered by CORS), so the
                // Origin header must be our own address. Requests without Origin come from non-browser tools.
                bool sensitive = ctx.Request.IsWebSocketRequest || ctx.Request.HttpMethod != "GET";
                if (sensitive && !OwnOrigin(ctx.Request.Headers["Origin"])) { ctx.Response.StatusCode = 403; ctx.Response.Close(); return; }
                if (path == "/audio" && ctx.Request.IsWebSocketRequest) { Audio(ctx); return; }
                if (path == "/screen" && ctx.Request.IsWebSocketRequest) { ScreenSocket(ctx); return; }
                if (path == "/api/purchases" && ctx.Request.HttpMethod == "POST") { SavePurchases(ctx); return; }
                if (path == "/api/diag" && ctx.Request.HttpMethod == "POST") { SaveDiag(ctx, false); return; }
                if (path == "/api/diagframe" && ctx.Request.HttpMethod == "POST") { SaveDiag(ctx, true); return; }
                ServeFile(ctx, path.TrimStart('/'));
            }
            catch { try { ctx.Response.Abort(); } catch { } }
        }

        // Our own page: http://localhost:PORT or http://127.0.0.1:PORT. No header at all: not a browser.
        static bool OwnOrigin(string origin)
        {
            if (origin == null) return true;
            return origin == "http://localhost:" + sitePort || origin == "http://127.0.0.1:" + sitePort;
        }

        static void ServeFile(HttpListenerContext ctx, string rel)
        {
            if (rel.Length == 0) rel = "index.html";
            string file = Path.GetFullPath(Path.Combine(root, rel));
            var res = ctx.Response;
            if (!file.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) { res.StatusCode = 404; res.Close(); return; }
            string type;
            res.ContentType = types.TryGetValue(Path.GetExtension(file).ToLowerInvariant(), out type) ? type : "application/octet-stream";
            res.Headers["Cache-Control"] = "no-cache";
            byte[] bytes = File.ReadAllBytes(file);
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
            res.Close();
        }

        // Diagnostics, local only (not in git): text lines go to diag/diag.log, frames to diag/frame-*.jpg.
        // The log is capped and only the newest DIAG_FRAMES frames are kept.
        const int DIAG_LOG_MAX = 2 * 1024 * 1024, DIAG_FRAMES = 40, DIAG_BODY_MAX = 4 * 1024 * 1024;
        static readonly object diagLock = new object();
        static void SaveDiag(HttpListenerContext ctx, bool frame)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            if (req.ContentLength64 <= 0 || req.ContentLength64 > DIAG_BODY_MAX) { res.StatusCode = 400; res.Close(); return; }
            byte[] body;
            using (var ms = new MemoryStream()) { req.InputStream.CopyTo(ms); body = ms.ToArray(); }
            string dir = Path.Combine(root, "diag");
            lock (diagLock)
            {
                Directory.CreateDirectory(dir);
                if (frame)
                {
                    File.WriteAllBytes(Path.Combine(dir, "frame-" + DateTime.Now.ToString("MMdd-HHmmss-fff") + ".jpg"), body);
                    var old = new DirectoryInfo(dir).GetFiles("frame-*.jpg");
                    Array.Sort(old, (a, b) => a.Name.CompareTo(b.Name));
                    for (int i = 0; i < old.Length - DIAG_FRAMES; i++) old[i].Delete();
                }
                else
                {
                    string log = Path.Combine(dir, "diag.log");
                    if (File.Exists(log) && new FileInfo(log).Length > DIAG_LOG_MAX) File.Delete(log);
                    File.AppendAllText(log, DateTime.Now.ToString("dd.MM HH:mm:ss.fff") + "  " + Encoding.UTF8.GetString(body) + "\n", new UTF8Encoding(false));
                }
            }
            res.StatusCode = 204;
            res.Close();
        }

        // Own purchases: the page sends their list, we write it to purchases.mine.json (not in git),
        // and sync.ps1 sends the new ones from there to the Worker on launch. The custom header is required:
        // a browser will not send such a request from another site without CORS permission, so no third party can overwrite the file.
        const int PURCHASES_MAX = 8 * 1024 * 1024;
        static void SavePurchases(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            if (req.Headers["X-Abi-Kaluvan"] != "1" || req.ContentLength64 <= 0 || req.ContentLength64 > PURCHASES_MAX) { res.StatusCode = 400; res.Close(); return; }
            string body;
            using (var reader = new StreamReader(req.InputStream, Encoding.UTF8)) body = reader.ReadToEnd();
            string trimmed = body.TrimStart();
            if (!trimmed.StartsWith("{") || body.IndexOf("\"purchases\"", StringComparison.Ordinal) < 0) { res.StatusCode = 400; res.Close(); return; }
            string file = Path.Combine(root, "purchases.mine.json");
            string tmp = file + ".tmp";
            File.WriteAllText(tmp, body, new UTF8Encoding(false));
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
            res.StatusCode = 204;
            res.Close();
        }

        static void Audio(HttpListenerContext ctx)
        {
            var ws = ctx.AcceptWebSocketAsync(null).Result.WebSocket;
            lock (clients) clients.Add(ws);
            Send(ws, Encoding.UTF8.GetBytes(status), WebSocketMessageType.Text);
            WaitClosed(ws);
            lock (clients) clients.Remove(ws);
            try { ws.Dispose(); } catch { }
        }

        static void ScreenSocket(HttpListenerContext ctx)
        {
            var ws = ctx.AcceptWebSocketAsync(null).Result.WebSocket;
            lock (screenClients) screenClients.Add(ws);
            lastCursorX = int.MinValue; // a new page gets the cursor position even if the mouse stands still
            Send(ws, Encoding.UTF8.GetBytes(ScreenStateJson()), WebSocketMessageType.Text);
            WaitClosed(ws);
            lock (screenClients) screenClients.Remove(ws);
            try { ws.Dispose(); } catch { }
        }

        // the page sends nothing; we read only to notice that it was closed
        static void WaitClosed(WebSocket ws)
        {
            var buf = new ArraySegment<byte>(new byte[256]);
            try
            {
                while (ws.State == WebSocketState.Open)
                {
                    var r = ws.ReceiveAsync(buf, CancellationToken.None).Result;
                    if (r.MessageType == WebSocketMessageType.Close) break;
                }
            }
            catch { }
        }

        static void Send(WebSocket ws, byte[] data, WebSocketMessageType type)
        {
            lock (ws)
            {
                try { ws.SendAsync(new ArraySegment<byte>(data), type, true, CancellationToken.None).Wait(); }
                catch { lock (clients) clients.Remove(ws); lock (screenClients) screenClients.Remove(ws); }
            }
        }

        // Screen frames — only while the page waits for them. Capture and JPEG encoding run in parallel
        // in two threads (for the right half of the window — ~8 and ~3 ms): up to 30 frames per second.
        static System.Drawing.Bitmap pending;    // a captured frame that is not encoded yet
        static string screenState = "start";     // game | nogame | minimized

        static void SetScreenState(string state)
        {
            if (state == screenState) return;
            screenState = state;
            WebSocket[] list;
            lock (screenClients) list = screenClients.ToArray();
            var msg = Encoding.UTF8.GetBytes(ScreenStateJson());
            foreach (var ws in list) Send(ws, msg, WebSocketMessageType.Text);
        }

        // crop: the frame is already the right part of the window (the merchant is always on the right), the page does not crop again
        const double MERCHANT_SIDE = 0.5;
        static string ScreenStateJson() { return "{\"type\":\"screen\",\"state\":\"" + screenState + "\",\"crop\":" + MERCHANT_SIDE.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}"; }
        static readonly AutoResetEvent hasPending = new AutoResetEvent(false);
        static int lastCursorX = int.MinValue, lastCursorY = int.MinValue; // the last cursor position sent

        // Capture only the client area of the game window: other monitors and apps never get into the frame
        static void ScreenLoop(string exe)
        {
            var enc = new Thread(EncodeLoop);
            enc.IsBackground = true;
            enc.Start();
            var watch = Stopwatch.StartNew();
            IntPtr hwnd = IntPtr.Zero;
            long lookedAt = -100000;
            while (true)
            {
                int count;
                lock (screenClients) count = screenClients.Count;
                if (count == 0) { Thread.Sleep(200); continue; }
                long started = watch.ElapsedMilliseconds;
                if (hwnd == IntPtr.Zero || started - lookedAt > 2000)
                {
                    lookedAt = started;
                    int pid = Loopback.FindProcess(exe);
                    hwnd = pid != 0 ? Screen.FindWindow(pid) : IntPtr.Zero;
                }
                var area = hwnd == IntPtr.Zero || Screen.IsIconic(hwnd) ? System.Drawing.Rectangle.Empty : Screen.ClientArea(hwnd);
                SetScreenState(hwnd == IntPtr.Zero ? "nogame" : area.Width < 100 || area.Height < 100 ? "minimized" : "game");
                if (screenState != "game") { Thread.Sleep(500); continue; }
                try
                {
                    // only the right part of the window: the merchant is there; capturing and encoding the left half is wasted
                    int cut = (int)Math.Round(area.Width * MERCHANT_SIDE);
                    var bmp = Screen.Capture(new System.Drawing.Rectangle(area.X + cut, area.Y, area.Width - cut, area.Height));
                    // if the previous one is not encoded yet, replace it with the fresh one, so the queue does not grow
                    var old = Interlocked.Exchange(ref pending, bmp);
                    if (old != null) old.Dispose();
                    hasPending.Set();
                    // the cursor in frame pixels, sent when it moves: the page then knows the cargo under the mouse
                    int cx, cy;
                    if (Screen.Cursor(out cx, out cy))
                    {
                        cx -= area.X + cut; cy -= area.Y;
                        if (cx != lastCursorX || cy != lastCursorY)
                        {
                            lastCursorX = cx; lastCursorY = cy;
                            var msg = Encoding.UTF8.GetBytes("{\"type\":\"cursor\",\"x\":" + cx + ",\"y\":" + cy + "}");
                            WebSocket[] list;
                            lock (screenClients) list = screenClients.ToArray();
                            foreach (var ws in list) Send(ws, msg, WebSocketMessageType.Text);
                        }
                    }
                }
                catch (Exception e) { Console.WriteLine("screen capture failed: " + e.Message); Thread.Sleep(1000); }
                int rest = SCREEN_FRAME_MS - (int)(watch.ElapsedMilliseconds - started);
                if (rest > 0) Thread.Sleep(rest);
            }
        }

        static void EncodeLoop()
        {
            bool wasBlack = false;
            int n = 0;
            while (true)
            {
                hasPending.WaitOne();
                var bmp = Interlocked.Exchange(ref pending, null);
                if (bmp == null) continue;
                try
                {
                    WebSocket[] list;
                    lock (screenClients) list = screenClients.ToArray();
                    if (n++ % BLACK_CHECK_EVERY == 0)
                    {
                        bool black = Screen.IsBlack(bmp);
                        if (black != wasBlack)
                        {
                            wasBlack = black;
                            var msg = Encoding.UTF8.GetBytes("{\"type\":\"screen\",\"black\":" + (black ? "true" : "false") + "}");
                            foreach (var ws in list) Send(ws, msg, WebSocketMessageType.Text);
                        }
                    }
                    byte[] frame = Screen.Encode(bmp);
                    foreach (var ws in list) Send(ws, frame, WebSocketMessageType.Binary);
                }
                catch (Exception e) { Console.WriteLine("screen frame failed: " + e.Message); }
                finally { bmp.Dispose(); }
            }
        }

        static void Broadcast(byte[] data, WebSocketMessageType type)
        {
            WebSocket[] list;
            lock (clients) list = clients.ToArray();
            foreach (var ws in list) Send(ws, data, type);
        }

        static void SetStatus(string state, int pid, string message)
        {
            status = "{\"type\":\"status\",\"state\":\"" + state + "\",\"pid\":" + pid + ",\"rate\":" + Loopback.SAMPLE_RATE +
                     ",\"message\":\"" + (message ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
            Broadcast(Encoding.UTF8.GetBytes(status), WebSocketMessageType.Text);
            Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + (state == "game" ? "listening to the game (PID " + pid + ")" : state == "wait" ? "game is not running, waiting for " + message : "error: " + message));
        }

        static void CaptureLoop(string exe)
        {
            string last = null;
            while (true)
            {
                int pid = Loopback.FindProcess(exe);
                if (pid == 0)
                {
                    if (last != "wait") SetStatus("wait", 0, exe + ".exe");
                    last = "wait";
                    Thread.Sleep(2000);
                    continue;
                }
                try
                {
                    SetStatus("game", pid, exe + ".exe");
                    last = "game";
                    Loopback.Run(pid, delegate (float[] mono)
                    {
                        var bytes = new byte[mono.Length * 4];
                        Buffer.BlockCopy(mono, 0, bytes, 0, bytes.Length);
                        Broadcast(bytes, WebSocketMessageType.Binary);
                    }, delegate { return false; });
                }
                catch (Exception e)
                {
                    SetStatus("error", pid, e.Message);
                    last = "error";
                    Thread.Sleep(3000);
                }
            }
        }
    }
}

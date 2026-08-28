<#
  AlterEgoWeb - tools/build-launcher.ps1

  Compiles "AlterEgo看板.exe", a tiny GUI launcher, so the tool can be started by
  double-clicking a normal-looking program instead of a .bat file.

  Why this works without installing anything: the C# compiler ships inside .NET
  Framework, which is part of Windows. Add-Type -OutputAssembly drives it. There
  is no SDK, no toolchain, no download.

  What the exe does:
    * finds its own folder, so it keeps working when the folder is moved
    * shows a small "scanning" window instead of a black console flash
    * runs tools\scan.ps1 hidden and captures its output
    * on failure, shows the message in a dialog rather than vanishing
    * on success, opens index.html in the default browser

  Run this once. Re-run it only if you edit the C# below.
  启动.bat keeps working either way -- if an antivirus quarantines the exe, the
  .bat is the fallback.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ToolsDir = $PSScriptRoot
if (-not $ToolsDir) { $ToolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$BaseDir = Split-Path -Parent $ToolsDir
$ExePath = Join-Path $BaseDir 'AlterEgo看板.exe'

Write-Host ''
Write-Host 'Building AlterEgoWeb launcher...'

# ---------------------------------------------------------------------------
# Icon: a 32x32 PNG wrapped in an ICO container.
# ICO has supported PNG payloads since Vista, which avoids hand-rolling a DIB.
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.Drawing

$IconPath = Join-Path $ToolsDir 'launcher.ico'
if (-not (Test-Path -LiteralPath $IconPath)) {
    $size = 64
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([System.Drawing.Color]::Transparent)

        $rect = New-Object System.Drawing.Rectangle(2, 2, ($size - 4), ($size - 4))
        $back = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 27, 30, 36))
        $g.FillRectangle($back, $rect)
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 74, 163, 255)), 3
        $g.DrawRectangle($pen, $rect)

        # Three bars, like the dashboard's vault indicator.
        $bar = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 70, 196, 109))
        $g.FillRectangle($bar, 14, 40, 10, 12)
        $g.FillRectangle($bar, 27, 30, 10, 22)
        $bar2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 229, 161, 58))
        $g.FillRectangle($bar2, 40, 20, 10, 32)

        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $png = $ms.ToArray()
        $ms.Dispose()

        $out = New-Object System.IO.MemoryStream
        $bw = New-Object System.IO.BinaryWriter($out)
        $bw.Write([uint16]0)          # reserved
        $bw.Write([uint16]1)          # type: icon
        $bw.Write([uint16]1)          # image count
        $bw.Write([byte]$size)        # width
        $bw.Write([byte]$size)        # height
        $bw.Write([byte]0)            # palette count
        $bw.Write([byte]0)            # reserved
        $bw.Write([uint16]1)          # color planes
        $bw.Write([uint16]32)         # bits per pixel
        $bw.Write([uint32]$png.Length)
        $bw.Write([uint32]22)         # offset: 6 + 16
        $bw.Write($png)
        $bw.Flush()
        [System.IO.File]::WriteAllBytes($IconPath, $out.ToArray())
        $bw.Dispose()
        Write-Host '  icon generated'
    } finally {
        $g.Dispose()
        $bmp.Dispose()
    }
}

# ---------------------------------------------------------------------------
# Launcher source
#
# The Chinese UI strings live in $T below and are injected as \uXXXX escapes, so
# the generated .cs file is pure ASCII. That matters: Add-Type writes the temp
# .cs using the default encoding, and on this machine (codepage 936) literal
# Chinese in the source comes back mangled -- the compiler reported
# "newline in constant" on a perfectly valid string.
# ---------------------------------------------------------------------------
$T = @{
    Title      = 'AlterEgo 本地看板'
    Scanning   = '正在扫描魔兽世界目录...'
    NoScript   = "找不到 tools\scan.ps1。`n请确认这个程序和 index.html、tools 文件夹在同一个目录里。"
    OutHead    = "`n`n--- 扫描输出 ---`n"
    Hint       = "`n`n提示：也可以直接双击 启动.bat 查看完整过程。"
    NoPwsh     = "无法运行 PowerShell 扫描脚本。`n"
    ScanFail   = '扫描失败，没有生成数据。'
    NoPage     = '扫描成功，但找不到 index.html。'
    NoBrowse   = "数据已生成，但无法自动打开浏览器。`n请手动打开 index.html。`n`n"
    Font       = 'Microsoft YaHei UI'
    TrayOpen   = '打开看板'
    TrayRescan = '立即重新扫描'
    TrayExit   = '退出'
    TrayIdle   = 'AlterEgo 本地看板 - 正在监视游戏存档'
    TrayBusy   = 'AlterEgo 本地看板 - 正在重新扫描...'
    TrayDone   = '数据已更新，页面会在下次刷新时显示'
    TrayNoWatch= 'AlterEgo 本地看板'
    TraySetDir = '设置游戏目录...'
    TrayShortcut='创建桌面快捷方式'
    PickDir    = '选择魔兽世界的安装目录（包含 _retail_ 的那一层）'
    DirBad     = "这个目录里没有找到 _retail_。`n请选择包含 _retail_ 文件夹的那一层，例如 D:\\World of Warcraft。"
    DirSaved   = '游戏目录已保存，正在重新扫描...'
    ShortcutOk = '桌面快捷方式已创建。'
    ShortcutBad= '创建快捷方式失败：'
    PageTitle  = 'AlterEgo 本地看板'
    TrayUpdate = '检查更新'
    UpdNewer   = '有新版本 {0}（当前 v{1}），点这里打开发布页'
    UpdCurrent = '已经是最新版本 v{0}'
    UpdFailed  = '检查更新失败，可能是网络不通。稍后再试。'
    CloseAsk   = "看板窗口已经关闭。`n`n要让程序继续留在托盘里（监视存档、自动重扫）吗？`n`n是 = 留在托盘　　否 = 一起退出"
    CloseTitle = '关闭看板之后'
    CloseRemem = '这个选择会记住，以后可以在托盘菜单的「关闭时行为」里改。'
    BehaveMenu = '关闭看板时'
    BehaveTray = '留在托盘'
    BehaveExit = '一起退出'
    BehaveAsk  = '每次询问'
}

# PowerShell string -> C# string literal, ASCII-only.
# Note: no `switch` here on purpose. Inside a switch, `continue` continues the
# SWITCH rather than the enclosing foreach, so a backslash got escaped and then
# emitted again, producing "\\\" and a compile error.
function ConvertTo-CsLiteral {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if     ($ch -ceq '"')  { [void]$sb.Append('\"') }
        elseif ($ch -ceq '\')  { [void]$sb.Append('\\') }
        elseif ($code -eq 10)  { [void]$sb.Append('\n') }
        elseif ($code -eq 13)  { [void]$sb.Append('\r') }
        elseif ($code -ge 32 -and $code -lt 127) { [void]$sb.Append($ch) }
        else { [void]$sb.Append('\u' + $code.ToString('x4')) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

$source = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

// `public` only so Add-Type stops warning that the generated type is not public.
public static class Launcher
{
    const string T_TITLE      = @@TITLE@@;
    const string T_SCANNING   = @@SCANNING@@;
    const string T_NOSCRIPT   = @@NOSCRIPT@@;
    const string T_OUTHEAD    = @@OUTHEAD@@;
    const string T_HINT       = @@HINT@@;
    const string T_NOPWSH     = @@NOPWSH@@;
    const string T_SCANFAIL   = @@SCANFAIL@@;
    const string T_NOPAGE     = @@NOPAGE@@;
    const string T_NOBROWSE   = @@NOBROWSE@@;
    const string T_FONT       = @@FONT@@;
    const string T_TRAYOPEN   = @@TRAYOPEN@@;
    const string T_TRAYRESCAN = @@TRAYRESCAN@@;
    const string T_TRAYEXIT   = @@TRAYEXIT@@;
    const string T_TRAYIDLE   = @@TRAYIDLE@@;
    const string T_TRAYBUSY   = @@TRAYBUSY@@;
    const string T_TRAYDONE   = @@TRAYDONE@@;
    const string T_TRAYNOWATCH= @@TRAYNOWATCH@@;
    const string T_TRAYSETDIR = @@TRAYSETDIR@@;
    const string T_TRAYSHORTCUT=@@TRAYSHORTCUT@@;
    const string T_PICKDIR    = @@PICKDIR@@;
    const string T_DIRBAD     = @@DIRBAD@@;
    const string T_DIRSAVED   = @@DIRSAVED@@;
    const string T_SHORTCUTOK = @@SHORTCUTOK@@;
    const string T_SHORTCUTBAD= @@SHORTCUTBAD@@;
    // Must match the <title> in index.html: it is how an already-open dashboard
    // window is found.
    const string T_PAGETITLE  = @@PAGETITLE@@;
    const string T_TRAYUPDATE = @@TRAYUPDATE@@;
    const string T_UPDNEWER   = @@UPDNEWER@@;
    const string T_UPDCURRENT = @@UPDCURRENT@@;
    const string T_UPDFAILED  = @@UPDFAILED@@;
    const string T_CLOSEASK   = @@CLOSEASK@@;
    const string T_CLOSETITLE = @@CLOSETITLE@@;
    const string T_CLOSEREMEM = @@CLOSEREMEM@@;
    const string T_BEHAVEMENU = @@BEHAVEMENU@@;
    const string T_BEHAVETRAY = @@BEHAVETRAY@@;
    const string T_BEHAVEEXIT = @@BEHAVEEXIT@@;
    const string T_BEHAVEASK  = @@BEHAVEASK@@;

    static string BaseDir;
    static string ScanScript;
    static string PageFile;
    static NotifyIcon Tray;
    static System.Windows.Forms.Timer Debounce;
    static bool Rescanning;
    static string UpdateUrl;
    static System.Windows.Forms.Timer WindowWatch;
    static bool SawWindow;
    // "" = ask on first close, "tray" = stay resident, "exit" = quit with it.
    static string CloseBehaviour = "";
    static ToolStripMenuItem[] BehaveItems;
    // MUST be held in a field. A FileSystemWatcher that only exists as a local
    // is eligible for collection as soon as the method returns, and then it
    // silently stops raising events.
    static System.Collections.Generic.List<FileSystemWatcher> Watchers =
        new System.Collections.Generic.List<FileSystemWatcher>();

    // Polling is the source of truth, not the watcher.
    //
    // Notifications turned out not to be dependable here: WoW does not simply
    // append to AlterEgo.lua, and a timestamp-only change did not raise a
    // LastWrite event in testing. A 20 s stat of four small files costs nothing
    // and cannot be missed, so the watcher is kept only to make the common case
    // feel instant.
    static System.Windows.Forms.Timer Poll;
    static System.Collections.Generic.List<string> WatchFiles =
        new System.Collections.Generic.List<string>();
    static System.Collections.Generic.Dictionary<string, string> LastSeen =
        new System.Collections.Generic.Dictionary<string, string>();

    // -------------------------------------------------------------- splash

    class Splash : Form
    {
        public Splash()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(320, 96);
            BackColor = Color.FromArgb(27, 30, 36);
            TopMost = true;
            ShowInTaskbar = false;

            Label title = new Label();
            title.Text = T_TITLE;
            title.ForeColor = Color.FromArgb(223, 228, 236);
            title.Font = new Font(T_FONT, 11F, FontStyle.Bold);
            title.AutoSize = false;
            title.TextAlign = ContentAlignment.MiddleCenter;
            title.Dock = DockStyle.Top;
            title.Height = 44;

            Label sub = new Label();
            sub.Text = T_SCANNING;
            sub.ForeColor = Color.FromArgb(152, 162, 179);
            sub.Font = new Font(T_FONT, 9F);
            sub.AutoSize = false;
            sub.TextAlign = ContentAlignment.MiddleCenter;
            sub.Dock = DockStyle.Fill;

            Controls.Add(sub);
            Controls.Add(title);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (Pen p = new Pen(Color.FromArgb(74, 163, 255), 2))
                e.Graphics.DrawRectangle(p, 1, 1, Width - 3, Height - 3);
        }
    }

    static void Fail(string headline, string detail)
    {
        string msg = headline;
        if (!string.IsNullOrEmpty(detail))
            msg += T_OUTHEAD + detail.Trim();
        msg += T_HINT;
        MessageBox.Show(msg, T_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    // ---------------------------------------------------------------- scan

    // Returns true on success. `output` gets stdout+stderr either way.
    static bool RunScan(out string output)
    {
        output = "";
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            // -Command rather than -File so the output encoding can be pinned to
            // UTF-8; the console codepage here is 936 and would mangle otherwise.
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command "
                + "\"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '"
                + ScanScript.Replace("'", "''") + "'\"";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            using (Process p = Process.Start(psi))
            {
                string so = p.StandardOutput.ReadToEnd();
                string se = p.StandardError.ReadToEnd();
                p.WaitForExit();
                output = (so + "\n" + se).Trim();
                return p.ExitCode == 0;
            }
        }
        catch (Exception ex)
        {
            output = T_NOPWSH + ex.Message;
            return false;
        }
    }

    // ----------------------------------------------------- window geometry

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct WINDOWPLACEMENT
    {
        public int length, flags, showCmd;
        public System.Drawing.Point ptMinPosition, ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

    static string GeometryFile { get { return Path.Combine(BaseDir, "data\\window.txt"); } }

    // Remembered as the RESTORED rect plus a maximized flag, not the current
    // rect: saving a maximized window's outer bounds would reopen it as a
    // non-maximized window the size of the screen, which is not the same thing.
    static void SaveGeometry(IntPtr hWnd)
    {
        try
        {
            WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
            wp.length = System.Runtime.InteropServices.Marshal.SizeOf(typeof(WINDOWPLACEMENT));
            if (!GetWindowPlacement(hWnd, ref wp)) return;

            RECT r = wp.rcNormalPosition;
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            if (w < 300 || h < 200) return;   // minimised or nonsense

            bool max = (wp.showCmd == 3);     // SW_SHOWMAXIMIZED
            string line = string.Format("{0} {1} {2} {3} {4}", r.Left, r.Top, w, h, max ? 1 : 0);
            Directory.CreateDirectory(Path.GetDirectoryName(GeometryFile));
            File.WriteAllText(GeometryFile, line, new UTF8Encoding(false));
        }
        catch { }
    }

    static string GeometryArgs()
    {
        try
        {
            if (!File.Exists(GeometryFile)) return "--window-size=1600,900";
            string[] p = File.ReadAllText(GeometryFile).Trim().Split(' ');
            if (p.Length < 4) return "--window-size=1600,900";
            int x, y, w, h;
            if (!int.TryParse(p[0], out x) || !int.TryParse(p[1], out y) ||
                !int.TryParse(p[2], out w) || !int.TryParse(p[3], out h))
                return "--window-size=1600,900";

            // A monitor that is gone would put the window off-screen.
            System.Drawing.Rectangle vs = SystemInformation.VirtualScreen;
            if (x + w < vs.Left + 80 || x > vs.Right - 80 ||
                y + h < vs.Top + 80 || y > vs.Bottom - 80)
                return "--window-size=1600,900";

            string args = "--window-position=" + x + "," + y + " --window-size=" + w + "," + h;
            if (p.Length > 4 && p[4] == "1") args += " --start-maximized";
            return args;
        }
        catch { return "--window-size=1600,900"; }
    }

    // ------------------------------------------------------- close behaviour

    static void StartWindowWatch()
    {
        WindowWatch = new System.Windows.Forms.Timer();
        WindowWatch.Interval = 2000;
        WindowWatch.Tick += OnWindowWatchTick;
        WindowWatch.Start();
    }

    static void OnWindowWatchTick(object sender, EventArgs e)
    {
        IntPtr h = FindDashboardWindow();
        if (h != IntPtr.Zero)
        {
            SawWindow = true;
            SaveGeometry(h);           // cheap, and survives a hard kill
            return;
        }
        if (!SawWindow) return;        // still starting up
        SawWindow = false;

        if (CloseBehaviour == "tray") return;
        if (CloseBehaviour == "exit") { QuitApp(); return; }

        // Unset: ask once and remember. Default (Enter / Esc) is to quit, which
        // is the least surprising for someone who just closed the window.
        DialogResult r = MessageBox.Show(T_CLOSEASK + "\n\n" + T_CLOSEREMEM, T_CLOSETITLE,
                                         MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                                         MessageBoxDefaultButton.Button2);
        CloseBehaviour = (r == DialogResult.Yes) ? "tray" : "exit";
        WriteConfigString("onWindowClose", CloseBehaviour);
        SyncBehaviourMenu();
        if (CloseBehaviour == "exit") QuitApp();
    }

    static void QuitApp()
    {
        IntPtr h = FindDashboardWindow();
        if (h != IntPtr.Zero) SaveGeometry(h);
        if (Tray != null) Tray.Visible = false;
        Application.Exit();
    }

    static void SetCloseBehaviour(string v)
    {
        CloseBehaviour = v;
        WriteConfigString("onWindowClose", v);
        SyncBehaviourMenu();
    }

    static void SyncBehaviourMenu()
    {
        if (BehaveItems == null) return;
        string[] vals = new string[] { "exit", "tray", "" };
        for (int i = 0; i < BehaveItems.Length; i++)
            BehaveItems[i].Checked = (vals[i] == CloseBehaviour);
    }

    // -------------------------------------------------------------- update

    // The page cannot do this itself: file:// blocks fetch and XHR outright. The
    // scan already asks the GitHub API, so a manual check is just a rescan plus
    // reading back what it wrote.
    static void CheckUpdate()
    {
        string output;
        if (!RunScan(out output))
        {
            Tray.BalloonTipTitle = T_TITLE;
            Tray.BalloonTipText = T_UPDFAILED;
            Tray.ShowBalloonTip(3000);
            return;
        }

        string dataFile = Path.Combine(BaseDir, "data\\data.js");
        string latest = "", current = "", url = "", err = "";
        try
        {
            string js = File.ReadAllText(dataFile, Encoding.UTF8);
            latest  = Grab(js, "latestVersion");
            current = Grab(js, "currentVersion");
            url     = Grab(js, "url");
            err     = Grab(js, "error");
        }
        catch { }

        if (!string.IsNullOrEmpty(url)) UpdateUrl = url;

        Tray.BalloonTipTitle = T_TITLE;
        if (string.IsNullOrEmpty(latest))
        {
            Tray.BalloonTipText = T_UPDFAILED + (string.IsNullOrEmpty(err) ? "" : ("\n" + err));
        }
        else if (IsNewer(latest, current))
        {
            Tray.BalloonTipText = string.Format(T_UPDNEWER, latest, current);
        }
        else
        {
            Tray.BalloonTipText = string.Format(T_UPDCURRENT, current);
        }
        Tray.ShowBalloonTip(5000);
    }

    // Narrow read of one string field out of the generated data.js. Not a JSON
    // parser: .NET Framework has none built in, and the shape here is fixed.
    static string Grab(string js, string key)
    {
        var m = System.Text.RegularExpressions.Regex.Match(
            js, "\"?" + key + "\"?\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        if (!m.Success) return "";
        return m.Groups[1].Value.Replace("\\\"", "\"").Replace("\\\\", "\\");
    }

    static bool IsNewer(string a, string b)
    {
        string[] pa = a.TrimStart('v', 'V').Split('.', '-', '+');
        string[] pb = b.TrimStart('v', 'V').Split('.', '-', '+');
        int n = Math.Max(pa.Length, pb.Length);
        for (int i = 0; i < n; i++)
        {
            int x = 0, y = 0;
            if (i < pa.Length) int.TryParse(pa[i], out x);
            if (i < pb.Length) int.TryParse(pb[i], out y);
            if (x != y) return x > y;
        }
        return false;
    }

    // ------------------------------------------------- single instance / focus

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr param);

    const int SW_RESTORE = 9;

    // Held for the process lifetime so it is not collected; a released mutex
    // would let a second instance through.
    static Mutex Single;

    /// The dashboard window handle, or IntPtr.Zero.
    static IntPtr FindDashboardWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr param)
        {
            if (!IsWindowVisible(hWnd)) return true;
            System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
            if (GetWindowText(hWnd, sb, sb.Capacity) == 0) return true;
            string title = sb.ToString();
            // Chrome/Edge app-mode windows are titled with the page's <title>.
            if (title.IndexOf(T_PAGETITLE, StringComparison.Ordinal) >= 0)
            {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        return found;
    }

    /// Focus an already-open dashboard window. Returns false if there is none.
    static bool FocusDashboard()
    {
        IntPtr found = FindDashboardWindow();
        if (found == IntPtr.Zero) return false;
        if (IsIconic(found)) ShowWindow(found, SW_RESTORE);
        SetForegroundWindow(found);
        return true;
    }

    // ------------------------------------------------------------- browser

    // Chrome/Edge --app= gives a chromeless window with its own taskbar entry,
    // so the dashboard looks like a standalone program while still running on a
    // real Chromium engine. There is no runtime to install: the WebView2 SDK is
    // not redistributable from here, and the old WebBrowser control is IE11,
    // which cannot render this page (CSS variables, flex gap, position sticky).
    static string FindBrowser()
    {
        string[] exes = new string[] { "chrome.exe", "msedge.exe" };
        foreach (string exe in exes)
        {
            string p = FromAppPaths(Registry.LocalMachine, exe);
            if (p == null) p = FromAppPaths(Registry.CurrentUser, exe);
            if (p != null && File.Exists(p)) return p;
        }
        string[] guesses = new string[] {
            @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
        };
        foreach (string g in guesses) if (File.Exists(g)) return g;
        return null;
    }

    static string FromAppPaths(RegistryKey root, string exe)
    {
        try
        {
            using (RegistryKey k = root.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
            {
                if (k == null) return null;
                object v = k.GetValue("");
                return v == null ? null : v.ToString().Trim('"');
            }
        }
        catch { return null; }
    }

    static void OpenDashboard()
    {
        // Reuse the window if one is already up. Chrome's --app= does not dedupe,
        // so without this every "open" piles on another window.
        if (FocusDashboard()) return;

        string url = new Uri(PageFile).AbsoluteUri;
        string browser = FindBrowser();
        if (browser != null)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(browser);
                psi.Arguments = "--app=\"" + url + "\" " + GeometryArgs();
                psi.UseShellExecute = false;
                Process.Start(psi);
                return;
            }
            catch { /* fall through to the default handler */ }
        }
        try
        {
            // Plain path, so it routes through the .html association and the
            // browser handles path-to-URL conversion (including any '#').
            ProcessStartInfo open = new ProcessStartInfo(PageFile);
            open.UseShellExecute = true;
            Process.Start(open);
        }
        catch (Exception ex)
        {
            Fail(T_NOBROWSE + ex.Message, null);
        }
    }

    // ------------------------------------------------------- game directory

    // A folder picker beats telling the user to hand-edit JSON, and it is the
    // only part of the config that ever needs changing on a machine where
    // auto-detection fails.
    static void PickGameDir()
    {
        FolderBrowserDialog dlg = new FolderBrowserDialog();
        dlg.Description = T_PICKDIR;
        dlg.ShowNewFolderButton = false;
        if (dlg.ShowDialog() != DialogResult.OK) return;

        string chosen = dlg.SelectedPath;
        // Accept either the root or the _retail_ folder itself.
        if (Directory.Exists(Path.Combine(chosen, "_retail_")))
        {
            // already the root
        }
        else if (string.Equals(Path.GetFileName(chosen.TrimEnd('\\')), "_retail_",
                               StringComparison.OrdinalIgnoreCase))
        {
            chosen = Path.GetDirectoryName(chosen.TrimEnd('\\'));
        }
        else
        {
            MessageBox.Show(T_DIRBAD, T_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        if (!WriteWowPath(chosen)) return;
        Tray.BalloonTipTitle = T_TITLE;
        Tray.BalloonTipText = T_DIRSAVED;
        Tray.ShowBalloonTip(2500);
        Rescan(true);
    }

    // Rewrites one key in tools/config.json. A regex rather than a JSON parser
    // because .NET Framework has no built-in JSON writer and the file is a
    // hand-maintained template full of "_comment" keys worth keeping.
    static bool WriteConfigRaw(string key, string rawJsonValue)
    {
        string cfg = Path.Combine(BaseDir, "tools\\config.json");
        try
        {
            string text = File.Exists(cfg) ? File.ReadAllText(cfg, Encoding.UTF8) : "{\n}\n";
            string line = "\"" + key + "\": " + rawJsonValue;
            // Value is an array [..], an object {..} or a scalar up to the comma
            // or closing brace.
            string pattern = "\"" + key + "\"\\s*:\\s*(\\[[^\\]]*\\]|\\{[^}]*\\}|[^,\\r\\n}]*)";

            if (System.Text.RegularExpressions.Regex.IsMatch(text, pattern))
            {
                text = System.Text.RegularExpressions.Regex.Replace(
                    text, pattern, line.Replace("$", "$$"));
            }
            else
            {
                int brace = text.IndexOf('{');
                if (brace < 0) return false;
                text = text.Substring(0, brace + 1) + "\n  " + line + "," + text.Substring(brace + 1);
            }
            // No BOM: PowerShell reads this with an explicit UTF8Encoding(false).
            File.WriteAllText(cfg, text, new UTF8Encoding(false));
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, T_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
    }

    static bool WriteWowPath(string dir)
    {
        return WriteConfigRaw("wowPaths", "[\"" + dir.Replace("\\", "\\\\") + "\"]");
    }

    static void WriteConfigString(string key, string value)
    {
        WriteConfigRaw(key, "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"");
    }

    static string ReadConfigString(string key)
    {
        try
        {
            string cfg = Path.Combine(BaseDir, "tools\\config.json");
            if (!File.Exists(cfg)) return "";
            string text = File.ReadAllText(cfg, Encoding.UTF8);
            var m = System.Text.RegularExpressions.Regex.Match(
                text, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? m.Groups[1].Value : "";
        }
        catch { return ""; }
    }

    // WScript.Shell via late binding: no COM reference to add, and it is present
    // on every Windows install.
    static void CreateDesktopShortcut()
    {
        try
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string exe = Assembly.GetExecutingAssembly().Location;
            string lnk = Path.Combine(desktop, Path.GetFileNameWithoutExtension(exe) + ".lnk");

            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            object sc = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod,
                                       null, shell, new object[] { lnk });
            Type st = sc.GetType();
            st.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, sc,
                            new object[] { exe });
            st.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, sc,
                            new object[] { BaseDir });
            st.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, sc,
                            new object[] { exe + ",0" });
            st.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, sc,
                            new object[] { T_TITLE });
            st.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, sc, null);

            Tray.BalloonTipTitle = T_TITLE;
            Tray.BalloonTipText = T_SHORTCUTOK;
            Tray.ShowBalloonTip(2500);
        }
        catch (Exception ex)
        {
            MessageBox.Show(T_SHORTCUTBAD + ex.Message, T_TITLE,
                            MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    // --------------------------------------------------------------- watch

    static void SetupWatchers()
    {
        string list = Path.Combine(BaseDir, "data\\watch.txt");
        if (!File.Exists(list)) { Tray.Text = T_TRAYNOWATCH; return; }

        foreach (string raw in File.ReadAllLines(list))
        {
            string dir = raw.Trim();
            if (dir.Length == 0 || !Directory.Exists(dir)) continue;

            string file = Path.Combine(dir, "AlterEgo.lua");
            WatchFiles.Add(file);
            LastSeen[file] = Stamp(file);

            try
            {
                FileSystemWatcher w = new FileSystemWatcher(dir, "AlterEgo.lua");
                // FileName included on purpose: a save that writes a new file and
                // renames it over the old one produces no LastWrite event at all.
                w.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size
                               | NotifyFilters.FileName | NotifyFilters.CreationTime;
                w.Changed += OnChanged;
                w.Created += OnChanged;
                w.Renamed += OnRenamed;
                w.EnableRaisingEvents = true;
                Watchers.Add(w);
            }
            catch { /* a path we cannot watch is not fatal; polling still covers it */ }
        }

        if (WatchFiles.Count == 0) { Tray.Text = T_TRAYNOWATCH; return; }

        Poll = new System.Windows.Forms.Timer();
        Poll.Interval = 20000;
        Poll.Tick += OnPollTick;
        Poll.Start();

        Tray.Text = T_TRAYIDLE;
    }

    // mtime + size, as a string. Cheap, and enough to notice any real save.
    static string Stamp(string file)
    {
        try
        {
            FileInfo fi = new FileInfo(file);
            if (!fi.Exists) return "-";
            return fi.LastWriteTimeUtc.Ticks + ":" + fi.Length;
        }
        catch { return "?"; }
    }

    static void OnPollTick(object sender, EventArgs e)
    {
        bool changed = false;
        foreach (string f in WatchFiles)
        {
            string now = Stamp(f);
            string was;
            if (!LastSeen.TryGetValue(f, out was)) was = "-";
            if (now != was) { LastSeen[f] = now; changed = true; }
        }
        if (changed) Rescan(false);
    }

    static void OnRenamed(object sender, RenamedEventArgs e)
    {
        Debounce.Stop();
        Debounce.Start();
    }

    static void OnChanged(object sender, FileSystemEventArgs e)
    {
        // WoW writes SavedVariables in bursts and the file is briefly incomplete,
        // so coalesce events and give the writer time to finish.
        Debounce.Stop();
        Debounce.Start();
    }

    static void OnDebounceTick(object sender, EventArgs e)
    {
        Debounce.Stop();
        Rescan(false);
    }

    static void Rescan(bool interactive)
    {
        if (Rescanning) return;
        Rescanning = true;
        Tray.Text = T_TRAYBUSY;
        try
        {
            string output;
            bool ok = RunScan(out output);
            Tray.Text = T_TRAYIDLE;
            if (!ok)
            {
                if (interactive) Fail(T_SCANFAIL, output);
                return;
            }
            // Re-baseline, or the poll would fire again on the same change.
            foreach (string f in WatchFiles) LastSeen[f] = Stamp(f);

            Tray.BalloonTipTitle = T_TITLE;
            Tray.BalloonTipText = T_TRAYDONE;
            Tray.ShowBalloonTip(2500);
        }
        finally { Rescanning = false; }
    }

    // ---------------------------------------------------------------- main

    [STAThread]
    static int Main()
    {
        Application.EnableVisualStyles();

        // The exe's own folder, not the working directory: a shortcut or "run as
        // administrator" would otherwise point us at System32.
        BaseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        ScanScript = Path.Combine(BaseDir, "tools\\scan.ps1");
        PageFile = Path.Combine(BaseDir, "index.html");

        if (!File.Exists(ScanScript)) { Fail(T_NOSCRIPT, null); return 1; }

        // One instance only. Double-clicking the exe again used to add another
        // tray icon and another file watcher; now it just brings the dashboard
        // forward (or opens it) and exits.
        //
        // Local\ rather than Global\: this is a per-user desktop tool, and a
        // Global name would collide between users on a shared machine.
        bool isFirst;
        Single = new Mutex(true, "Local\\AlterEgoWeb.SingleInstance", out isFirst);
        if (!isFirst)
        {
            if (!FocusDashboard() && File.Exists(PageFile)) OpenDashboard();
            return 0;
        }

        Splash splash = new Splash();
        splash.Show();
        Application.DoEvents();

        string firstOutput;
        bool first = RunScan(out firstOutput);
        splash.Close();

        if (!first) { Fail(T_SCANFAIL, firstOutput); return 1; }
        if (!File.Exists(PageFile)) { Fail(T_NOPAGE, firstOutput); return 1; }

        OpenDashboard();

        // Stay resident so the game writing SavedVariables triggers a rescan.
        // The tray icon is the only UI and it has an explicit exit -- a hidden
        // background process would be worse than not having the feature.
        Tray = new NotifyIcon();
        try
        {
            Tray.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        }
        catch { Tray.Icon = SystemIcons.Application; }
        Tray.Visible = true;

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add(T_TRAYOPEN, null, delegate(object s, EventArgs e) { OpenDashboard(); });
        menu.Items.Add(T_TRAYRESCAN, null, delegate(object s, EventArgs e) { Rescan(true); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(T_TRAYUPDATE, null, delegate(object s, EventArgs e) { CheckUpdate(); });

        ToolStripMenuItem behave = new ToolStripMenuItem(T_BEHAVEMENU);
        ToolStripMenuItem bExit = new ToolStripMenuItem(T_BEHAVEEXIT, null,
            delegate(object s, EventArgs e) { SetCloseBehaviour("exit"); });
        ToolStripMenuItem bTray = new ToolStripMenuItem(T_BEHAVETRAY, null,
            delegate(object s, EventArgs e) { SetCloseBehaviour("tray"); });
        ToolStripMenuItem bAsk = new ToolStripMenuItem(T_BEHAVEASK, null,
            delegate(object s, EventArgs e) { SetCloseBehaviour(""); });
        behave.DropDownItems.Add(bExit);
        behave.DropDownItems.Add(bTray);
        behave.DropDownItems.Add(bAsk);
        BehaveItems = new ToolStripMenuItem[] { bExit, bTray, bAsk };
        menu.Items.Add(behave);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(T_TRAYSETDIR, null, delegate(object s, EventArgs e) { PickGameDir(); });
        menu.Items.Add(T_TRAYSHORTCUT, null, delegate(object s, EventArgs e) { CreateDesktopShortcut(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(T_TRAYEXIT, null, delegate(object s, EventArgs e) { QuitApp(); });
        Tray.ContextMenuStrip = menu;
        Tray.DoubleClick += delegate(object s, EventArgs e) { OpenDashboard(); };
        Tray.BalloonTipClicked += delegate(object s, EventArgs e)
        {
            if (string.IsNullOrEmpty(UpdateUrl)) return;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(UpdateUrl);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch { }
        };

        Debounce = new System.Windows.Forms.Timer();
        Debounce.Interval = 4000;
        Debounce.Tick += OnDebounceTick;

        SetupWatchers();

        CloseBehaviour = ReadConfigString("onWindowClose");
        if (CloseBehaviour != "tray" && CloseBehaviour != "exit") CloseBehaviour = "";
        SyncBehaviourMenu();
        StartWindowWatch();

        Application.Run();

        try { Single.ReleaseMutex(); } catch { /* already gone */ }
        return 0;
    }
}
'@

foreach ($k in $T.Keys) {
    $source = $source.Replace('@@' + $k.ToUpper() + '@@', (ConvertTo-CsLiteral $T[$k]))
}
if ($source -match '@@[A-Z]+@@') {
    throw "a UI string placeholder was left unsubstituted: $($Matches[0])"
}

# A running instance holds the file open, and "access denied" here is confusing.
# Say what to do instead.
if (Test-Path -LiteralPath $ExePath) {
    $running = @(Get-Process -ErrorAction SilentlyContinue |
                 Where-Object { $_.Path -eq $ExePath })
    if ($running.Count -gt 0) {
        throw ("The launcher is currently running (PID " +
               (($running | ForEach-Object { $_.Id }) -join ', ') +
               ").`r`n  Exit it from the tray icon first, then run this again.")
    }
    try { Remove-Item -LiteralPath $ExePath -Force }
    catch { throw ("Cannot replace $ExePath : " + $_.Exception.Message) }
}

# -CompilerParameters is mutually exclusive with -ReferencedAssemblies /
# -OutputAssembly / -OutputType, and ReferencedAssemblies is a read-only
# StringCollection that has to be filled with .Add().
$cp = New-Object System.CodeDom.Compiler.CompilerParameters
$cp.GenerateExecutable = $true
$cp.GenerateInMemory   = $false
$cp.OutputAssembly     = $ExePath
# /target:winexe is what suppresses the console window.
$cp.CompilerOptions    = "/target:winexe /win32icon:`"$IconPath`""
foreach ($r in @('System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll')) {
    [void]$cp.ReferencedAssemblies.Add($r)
}

# -WarningAction: Add-Type emits a benign "no public members" style warning for a
# type whose only member is Main. Nothing to fix, so keep the output clean.
Add-Type -TypeDefinition $source -CompilerParameters $cp -ErrorAction Stop -WarningAction SilentlyContinue

if (Test-Path -LiteralPath $ExePath) {
    $kb = [math]::Round((Get-Item -LiteralPath $ExePath).Length / 1KB, 1)
    Write-Host "  built: $ExePath ($kb KB)"
    Write-Host ''
    Write-Host 'Done. Double-click "AlterEgo看板.exe" to use it.' -ForegroundColor Green
} else {
    Write-Host '  build produced no file' -ForegroundColor Red
    exit 1
}

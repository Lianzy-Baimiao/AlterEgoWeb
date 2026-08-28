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

    static string BaseDir;
    static string ScanScript;
    static string PageFile;
    static NotifyIcon Tray;
    static System.Windows.Forms.Timer Debounce;
    static bool Rescanning;
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
        string url = new Uri(PageFile).AbsoluteUri;
        string browser = FindBrowser();
        if (browser != null)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(browser);
                psi.Arguments = "--app=\"" + url + "\" --window-size=1600,900";
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
        menu.Items.Add(T_TRAYEXIT, null, delegate(object s, EventArgs e)
        {
            Tray.Visible = false;
            Application.Exit();
        });
        Tray.ContextMenuStrip = menu;
        Tray.DoubleClick += delegate(object s, EventArgs e) { OpenDashboard(); };

        Debounce = new System.Windows.Forms.Timer();
        Debounce.Interval = 4000;
        Debounce.Tick += OnDebounceTick;

        SetupWatchers();

        Application.Run();
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

if (Test-Path -LiteralPath $ExePath) { Remove-Item -LiteralPath $ExePath -Force }

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

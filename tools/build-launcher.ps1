<#
  WowAltBoard - tools/build-launcher.ps1

  Compiles "魔兽看板.exe", a tiny GUI launcher, so the tool can be started by
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
$ExePath = Join-Path $BaseDir '魔兽看板.exe'

Write-Host ''
Write-Host 'Building WowAltBoard launcher...'

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
    Title      = '魔兽多角色看板'
    Scanning   = '正在扫描魔兽世界目录...'
    NoScript   = "找不到 tools\scan.ps1。`n请确认这个程序和 index.html、tools 文件夹在同一个目录里。"
    Footnote   = '想看完整的扫描过程，可以双击本文件夹里的 启动.bat。'
    NoPwsh     = "无法运行 PowerShell 扫描脚本。`n"
    NoPage     = "扫描成功，但找不到 index.html。`n请确认这个程序和 index.html 在同一个目录里。"
    NoBrowse   = "数据已生成，但无法自动打开浏览器。`n请手动打开 index.html。"
    Font       = 'Microsoft YaHei UI'
    TrayOpen   = '打开看板'
    TrayRescan = '立即重新扫描'
    TrayExit   = '退出'
    TrayIdle   = '魔兽多角色看板 - 正在监视游戏存档'
    TrayBusy   = '魔兽多角色看板 - 正在重新扫描...'
    TrayDone   = '数据已更新，页面会在下次刷新时显示'
    TrayNoWatch= '魔兽多角色看板'
    TraySetDir = '设置游戏目录...'
    TrayShortcut='创建桌面快捷方式'
    PickDir    = '选择魔兽世界的安装目录（包含 _retail_ 的那一层）'
    DirBad     = "这个目录里没有找到 _retail_。`n请选择包含 _retail_ 文件夹的那一层，例如 D:\\World of Warcraft。"
    DirSaved   = '游戏目录已保存，正在重新扫描...'
    ShortcutOk = '桌面快捷方式已创建。'
    ShortcutBad= '创建快捷方式失败：'
    PageTitle  = '魔兽多角色看板'
    TrayUpdate = '检查更新'
    UpdNewer   = '有新版本 {0}（当前 v{1}），点这里打开发布页'
    UpdCurrent = '已经是最新版本 v{0}'
    UpdFailed  = '检查更新失败，可能是网络不通。稍后再试。'
    UpdTitle    = '检查更新'
    UpdChecking = '正在联网检查更新...'
    UpdNewerAsk = "发现新版本 {0}`n`n你现在用的是 {1}。`n`n要打开发布页去下载吗？"
    UpdNoNew    = "已经是最新版本 {0}，不用更新。"
    UpdFailAsk  = "没能连上 GitHub，所以查不到有没有新版本。`n`nGitHub 在国内经常访问不到，这多半是网络问题，不是程序坏了。`n`n技术细节：{0}`n`n要打开发布页自己看一眼吗？（同样需要能访问 GitHub）"
    CloseAsk   = "看板窗口已经关闭。`n`n要让程序继续留在托盘里（监视存档、自动重扫）吗？`n`n是 = 留在托盘　　否 = 一起退出"
    CloseTitle = '关闭看板之后'
    CloseRemem = '这个选择会记住，以后可以在托盘菜单的「关闭时行为」里改。'
    BehaveMenu = '关闭看板时'
    BehaveTray = '留在托盘'
    BehaveExit = '一起退出'
    BehaveAsk  = '每次询问'

    # ---- failure explanations, keyed by scan.ps1's SCAN_ERROR code ----------
    # scan.ps1's own output is ASCII English on purpose (console codepage 936).
    # These are what the user actually reads: what went wrong, and the exact
    # steps out of it. %ADDONS% is replaced at runtime with the real
    # Interface\AddOns path that the scan reported.
    BtnRetry   = '重新扫描'
    BtnSetDir  = '设置游戏目录...'
    BtnAddons  = '打开插件目录'
    BtnDownload= '下载 AlterEgo'
    BtnDetail  = '详细信息 ▼'
    BtnDetail2 = '详细信息 ▲'
    BtnCopy    = '复制详情'
    BtnCopied  = '已复制'
    BtnClose   = '关闭'
    AddonUrl   = 'https://www.curseforge.com/wow/addons/alterego'

    HeadNoWow  = '没有找到魔兽世界的安装目录'
    BodyNoWow  = "注册表、战网配置、常见路径都试过了，都没找到，需要你手动指定一次。`n`n1. 点下面的「设置游戏目录」；`n2. 选中包含 _retail_ 的那一层，例如 D:\World of Warcraft；`n3. 选完会自动保存并重新扫描。"

    HeadNoAddon= '你还没有安装 AlterEgo 插件'
    BodyNoAddon= "这个看板只负责把 AlterEgo 插件存下来的数据整理成网页，它自己不进游戏取数据。所以必须先装插件，并且进游戏跑一次让它存盘。`n`n1. 下载 AlterEgo：点下面的「下载 AlterEgo」，或者在 CurseForge 客户端里搜 AlterEgo；`n2. 解压到这个目录：`n      %ADDONS%`n   解压后应该能直接看到 AlterEgo\AlterEgo.toc 这个文件；`n3. 启动游戏，登录任意一个角色；`n4. 输入 /reload，或者退出登录、退出游戏 —— 插件的数据是这个时候才写进硬盘的；`n5. 回来点下面的「重新扫描」。"

    HeadBroken = 'AlterEgo 插件的目录层级不对，游戏加载不了'
    BodyBroken = "找到了 AlterEgo 文件夹，但里面没有 AlterEgo.toc。这基本上都是解压的时候多套了一层目录。`n`n对的：  %ADDONS%\AlterEgo\AlterEgo.toc`n错的：  ...\AddOns\AlterEgo\AlterEgo\AlterEgo.toc`n`n如果是后一种，把里面那层 AlterEgo 文件夹整个剪出来，覆盖掉外面那层就行。`n`n改完启动游戏登录一次角色，输入 /reload，再回来点下面的「重新扫描」。"

    HeadDisabled='AlterEgo 插件装好了，但被禁用了'
    BodyDisabled="所有角色的插件列表里 AlterEgo 都是关闭状态，游戏不会加载它，也就不会产生任何数据。`n`n1. 启动游戏，在角色选择界面点左下角的「插件」；`n2. 勾上 AlterEgo（右上角切到「全部角色」可以一次全开）；`n3. 登录角色，输入 /reload，或者退出登录、退出游戏；`n4. 回来点下面的「重新扫描」。"

    HeadNoChar = '这个游戏目录里还没有任何角色数据'
    BodyNoChar = "看起来这个魔兽世界从来没登录过，或者它不是你平时在玩的那个安装目录 —— 装了两份、或者放在别的盘，这种情况很常见。`n`n1. 先用下面的「设置游戏目录」确认选的是哪一个；`n2. 启动游戏登录一个角色，然后退出游戏；`n3. 回来点「重新扫描」。"

    HeadNoSaved= 'AlterEgo 插件已经装好，但还没有生成数据'
    BodyNoSaved= "插件在位，也是开启的，只是还没往硬盘里写过存档。插件的数据只在 /reload、退出登录、退出游戏这三个时机才落盘 —— 游戏开着的时候它只在内存里。`n`n1. 启动游戏，登录任意一个角色；`n2. 点一下小地图上的 AlterEgo 图标，让它把这个角色的数据收一遍；`n3. 输入 /reload，或者退出登录、退出游戏；`n4. 回来点下面的「重新扫描」。`n`n（本程序常驻托盘时会盯着存档文件，你在游戏里 /reload 之后它会自己重扫。）"

    HeadUnread = '找到了 AlterEgo 的存档，但读到的内容不完整'
    BodyUnread = "一般是游戏还开着，存档文件正在被写入，读到的是半截内容。`n`n1. 完全退出魔兽世界 —— 不是回角色选择界面，是把游戏关掉；`n2. 回来点下面的「重新扫描」。`n`n如果游戏确实已经关了还是这个提示，那就是存档文件坏了：删掉它，进游戏重新收集一次即可。"

    HeadUnknown= '扫描失败，没有生成数据'
    BodyUnknown= "这次的失败原因不在已知情况里。下面的「详细信息」是扫描器的原始输出，可以照着排查，也可以点「复制详情」发给作者。"
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
using System.Net;
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
    const string T_FOOTNOTE   = @@FOOTNOTE@@;
    const string T_NOPWSH     = @@NOPWSH@@;
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
    const string T_UPDTITLE   = @@UPDTITLE@@;
    const string T_UPDCHECKING= @@UPDCHECKING@@;
    const string T_UPDNEWERASK= @@UPDNEWERASK@@;
    const string T_UPDNONEW   = @@UPDNONEW@@;
    const string T_UPDFAILASK = @@UPDFAILASK@@;
    const string T_CLOSEASK   = @@CLOSEASK@@;
    const string T_CLOSETITLE = @@CLOSETITLE@@;
    const string T_CLOSEREMEM = @@CLOSEREMEM@@;
    const string T_BEHAVEMENU = @@BEHAVEMENU@@;
    const string T_BEHAVETRAY = @@BEHAVETRAY@@;
    const string T_BEHAVEEXIT = @@BEHAVEEXIT@@;
    const string T_BEHAVEASK  = @@BEHAVEASK@@;

    const string T_BTNRETRY   = @@BTNRETRY@@;
    const string T_BTNSETDIR  = @@BTNSETDIR@@;
    const string T_BTNADDONS  = @@BTNADDONS@@;
    const string T_BTNDOWNLOAD= @@BTNDOWNLOAD@@;
    const string T_BTNDETAIL  = @@BTNDETAIL@@;
    const string T_BTNDETAIL2 = @@BTNDETAIL2@@;
    const string T_BTNCOPY    = @@BTNCOPY@@;
    const string T_BTNCOPIED  = @@BTNCOPIED@@;
    const string T_BTNCLOSE   = @@BTNCLOSE@@;
    const string T_ADDONURL   = @@ADDONURL@@;
    const string T_HEADNOWOW  = @@HEADNOWOW@@;
    const string T_BODYNOWOW  = @@BODYNOWOW@@;
    const string T_HEADNOADDON= @@HEADNOADDON@@;
    const string T_BODYNOADDON= @@BODYNOADDON@@;
    const string T_HEADBROKEN = @@HEADBROKEN@@;
    const string T_BODYBROKEN = @@BODYBROKEN@@;
    const string T_HEADDISABLED=@@HEADDISABLED@@;
    const string T_BODYDISABLED=@@BODYDISABLED@@;
    const string T_HEADNOCHAR = @@HEADNOCHAR@@;
    const string T_BODYNOCHAR = @@BODYNOCHAR@@;
    const string T_HEADNOSAVED= @@HEADNOSAVED@@;
    const string T_BODYNOSAVED= @@BODYNOSAVED@@;
    const string T_HEADUNREAD = @@HEADUNREAD@@;
    const string T_BODYUNREAD = @@BODYUNREAD@@;
    const string T_HEADUNKNOWN= @@HEADUNKNOWN@@;
    const string T_BODYUNKNOWN= @@BODYUNKNOWN@@;

    static string BaseDir;
    static string ScanScript;
    static string PageFile;
    static NotifyIcon Tray;
    static System.Windows.Forms.Timer Debounce;
    static bool Rescanning;
    static string UpdateUrl;
    static System.Windows.Forms.Timer WindowWatch;
    static bool SawWindow;
    // True once we have opened the dashboard in Chrome/Edge app mode, i.e. in a
    // window that contains nothing but our page. Gates closing it on exit.
    static bool OwnAppWindow;
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
        public Splash() : this(T_SCANNING) { }

        public Splash(string message)
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
            sub.Text = message;
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

    // ------------------------------------------------------------ failure UI
    //
    // This was a MessageBox whose body was the scanner's raw English log. For
    // the audience this tool has, that is not a message -- it is a wall of text
    // with the answer missing. scan.ps1 now classifies the failure and prints
    // "SCAN_ERROR=<code>", so the dialog can say what went wrong in Chinese,
    // list the steps that fix it, offer the one button that helps, and keep the
    // log behind a toggle for bug reports.
    class FailDialog : Form
    {
        const int W = 680;          // client width
        const int PAD = 18;
        const int DETAIL_H = 200;

        TextBox Detail;
        Button Toggle;
        Control DefaultFocus;
        string Raw;
        int RowBottom;              // client height with the log collapsed

        // Explicit measurement rather than AutoSize: each block's height is
        // needed to place the next one, and AutoSize only settles during layout.
        static int Measure(string text, Font f, int w)
        {
            return TextRenderer.MeasureText(text, f, new Size(w, int.MaxValue),
                       TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl).Height + 4;
        }

        Label AddText(string s, Font f, Color c, int x, int y, int w)
        {
            Label l = new Label();
            l.Font = f;
            l.ForeColor = c;
            l.Text = s;
            l.AutoSize = false;
            l.Bounds = new Rectangle(x, y, w, Measure(s, f, w));
            Controls.Add(l);
            return l;
        }

        static Button AddButton(string text, Font f)
        {
            Button b = new Button();
            b.Font = f;
            b.Text = text;
            b.Height = 30;
            b.Width = Math.Max(88, TextRenderer.MeasureText(text, f).Width + 28);
            b.FlatStyle = FlatStyle.System;
            return b;
        }
        public FailDialog(string head, string body, string raw,
                          string[] labels, EventHandler[] actions, bool expand)
        {
            Raw = Normalize(raw);

            Text = T_TITLE;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;

            Font headFont = new Font(T_FONT, 13.5F, FontStyle.Bold);
            Font bodyFont = new Font(T_FONT, 10F);
            Font hintFont = new Font(T_FONT, 8.5F);
            Font btnFont  = new Font(T_FONT, 9F);

            int left = PAD + 46;
            int tw = W - left - PAD;
            int y = PAD;

            PictureBox pic = new PictureBox();
            pic.Image = SystemIcons.Error.ToBitmap();
            pic.SizeMode = PictureBoxSizeMode.Zoom;
            pic.Bounds = new Rectangle(PAD, y + 2, 32, 32);
            Controls.Add(pic);

            y = AddText(head, headFont, Color.FromArgb(176, 42, 42), left, y, tw).Bottom + 14;
            if (!string.IsNullOrEmpty(body))
                y = AddText(body, bodyFont, Color.FromArgb(38, 42, 50), left, y, tw).Bottom + 16;
            y = AddText(T_FOOTNOTE, hintFont, Color.FromArgb(132, 138, 150), left, y, tw).Bottom + 18;
            // ---- button row: actions then 关闭, right-aligned as one group ----
            Button close = AddButton(T_BTNCLOSE, btnFont);
            close.DialogResult = DialogResult.Cancel;

            int n = (labels == null) ? 0 : labels.Length;
            Button[] acts = new Button[n];
            int total = close.Width;
            for (int i = 0; i < n; i++)
            {
                acts[i] = AddButton(labels[i], btnFont);
                acts[i].Click += actions[i];
                total += acts[i].Width + 8;
            }

            int x = W - PAD - total;
            for (int i = 0; i < n; i++)
            {
                acts[i].Location = new Point(x, y);
                Controls.Add(acts[i]);
                x += acts[i].Width + 8;
            }
            close.Location = new Point(x, y);
            Controls.Add(close);

            if (Raw.Length > 0)
            {
                Toggle = AddButton(T_BTNDETAIL, btnFont);
                Toggle.Location = new Point(PAD, y);
                Toggle.Click += delegate(object s, EventArgs e) { SetExpanded(!Detail.Visible); };
                Controls.Add(Toggle);

                // Confirms in place rather than via a balloon: on a first-run
                // failure there is no tray icon yet to show one.
                Button copy = AddButton(T_BTNCOPY, btnFont);
                copy.Location = new Point(Toggle.Right + 8, y);
                copy.Click += delegate(object s, EventArgs e)
                {
                    try
                    {
                        Clipboard.SetText(Raw);
                        copy.Text = T_BTNCOPIED;
                        copy.Enabled = false;
                    }
                    catch { }
                };
                Controls.Add(copy);
                Detail = new TextBox();
                Detail.Multiline = true;
                Detail.ReadOnly = true;
                Detail.WordWrap = false;
                Detail.ScrollBars = ScrollBars.Both;
                Detail.Font = new Font("Consolas", 8.5F);
                Detail.BackColor = Color.FromArgb(246, 247, 249);
                Detail.Text = Raw;
                Detail.Bounds = new Rectangle(PAD, y + 30 + 12, W - 2 * PAD, DETAIL_H);
                Detail.Visible = false;
                Controls.Add(Detail);
            }

            RowBottom = y + 30 + PAD;
            // 重新扫描 is always the last action, and it is what the user wants
            // after following the steps above -- so it gets the focus ring and
            // Enter. Without this the ring lands on whatever was added first,
            // while Enter fires something else, which reads as a bug.
            CancelButton = close;
            AcceptButton = (n > 0) ? acts[n - 1] : close;
            DefaultFocus = (n > 0) ? (Control)acts[n - 1] : (Control)close;
            SetExpanded(expand && Raw.Length > 0);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (DefaultFocus != null) DefaultFocus.Focus();
        }

        void SetExpanded(bool on)
        {
            if (Detail != null)
            {
                Detail.Visible = on;
                Toggle.Text = on ? T_BTNDETAIL2 : T_BTNDETAIL;
            }
            ClientSize = new Size(W, (on && Detail != null) ? Detail.Bottom + PAD : RowBottom);
        }

        // RunScan joins stdout and stderr with a bare \n, so the log arrives with
        // mixed line endings and a TextBox renders a lone \n as a box glyph.
        static string Normalize(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", "\r\n").Trim();
        }
    }
    // Generic failure: first line becomes the headline, the rest the body.
    static void Fail(string message, string detail)
    {
        string head = message, body = "";
        int nl = message.IndexOf('\n');
        if (nl >= 0)
        {
            head = message.Substring(0, nl).Trim();
            body = message.Substring(nl + 1).Trim();
        }
        FailDialog dlg = new FailDialog(head, body, detail, new string[0],
                                       new EventHandler[0], !string.IsNullOrEmpty(detail));
        dlg.ShowDialog();
    }

    // scan.ps1 prints "SCAN_ERROR=<code>" and "SCAN_DATA=<key>=<value>" on the
    // failure path. Read those back rather than pattern-matching English prose.
    static string ScanErrorCode(string output)
    {
        var m = System.Text.RegularExpressions.Regex.Match(output, "^SCAN_ERROR=([A-Z_]+)",
                    System.Text.RegularExpressions.RegexOptions.Multiline);
        return m.Success ? m.Groups[1].Value : "";
    }

    static string ScanErrorData(string output, string key)
    {
        var m = System.Text.RegularExpressions.Regex.Match(output, "^SCAN_DATA=" + key + "=(.*)$",
                    System.Text.RegularExpressions.RegexOptions.Multiline);
        return m.Success ? m.Groups[1].Value.Trim() : "";
    }

    static void OpenUrl(string url)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, T_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static void OpenFolder(string dir)
    {
        try
        {
            // A WoW install always has Interface\AddOns, but creating it is
            // harmless and beats opening nothing if it somehow went missing.
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            ProcessStartInfo psi = new ProcessStartInfo("explorer.exe", "\"" + dir + "\"");
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, T_TITLE, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
    /// Explains a failed scan. Returns DialogResult.Retry when the user fixed
    /// something and wants another go.
    static DialogResult FailScan(string output)
    {
        string code = ScanErrorCode(output);
        string addons = ScanErrorData(output, "addonsDir");
        bool haveAddons = addons.Length > 3 && addons.IndexOf(":\\") == 1;

        string head, body;
        bool wantSetDir = false, wantAddons = false, wantDownload = false, expand = false;

        if      (code == "NO_WOW")         { head = T_HEADNOWOW;    body = T_BODYNOWOW;    wantSetDir = true; }
        else if (code == "NO_ADDON")       { head = T_HEADNOADDON;  body = T_BODYNOADDON;  wantDownload = true; wantAddons = true; }
        else if (code == "ADDON_BROKEN")   { head = T_HEADBROKEN;   body = T_BODYBROKEN;   wantAddons = true; }
        else if (code == "ADDON_DISABLED") { head = T_HEADDISABLED; body = T_BODYDISABLED; }
        else if (code == "NO_CHARACTER")   { head = T_HEADNOCHAR;   body = T_BODYNOCHAR;   wantSetDir = true; }
        else if (code == "NO_SAVEDVARS")   { head = T_HEADNOSAVED;  body = T_BODYNOSAVED;  }
        else if (code == "SV_UNREADABLE")  { head = T_HEADUNREAD;   body = T_BODYUNREAD;   }
        else                               { head = T_HEADUNKNOWN;  body = T_BODYUNKNOWN;  expand = true; }

        body = body.Replace("%ADDONS%", haveAddons ? addons : "...\\_retail_\\Interface\\AddOns");

        // Assigned before ShowDialog, so the closures below see a live dialog.
        FailDialog dlg = null;
        var labels = new System.Collections.Generic.List<string>();
        var acts = new System.Collections.Generic.List<EventHandler>();

        if (wantDownload)
        {
            labels.Add(T_BTNDOWNLOAD);
            acts.Add(delegate(object s, EventArgs e) { OpenUrl(T_ADDONURL); });
        }
        if (wantAddons && haveAddons)
        {
            labels.Add(T_BTNADDONS);
            acts.Add(delegate(object s, EventArgs e) { OpenFolder(addons); });
        }
        if (wantSetDir)
        {
            labels.Add(T_BTNSETDIR);
            acts.Add(delegate(object s, EventArgs e)
            {
                if (PickGameDir()) dlg.DialogResult = DialogResult.Retry;
            });
        }
        labels.Add(T_BTNRETRY);
        acts.Add(delegate(object s, EventArgs e) { dlg.DialogResult = DialogResult.Retry; });

        dlg = new FailDialog(head, body, output, labels.ToArray(), acts.ToArray(), expand);
        return dlg.ShowDialog();
    }
    // A failed first scan happens before the tray icon exists, so anything that
    // can run on that path has to tolerate Tray == null.
    static void SetTrayText(string s)
    {
        if (Tray != null) Tray.Text = s;
    }

    static void Notify(string text)
    {
        if (Tray == null || !Tray.Visible) return;
        Tray.BalloonTipTitle = T_TITLE;
        Tray.BalloonTipText = text;
        Tray.ShowBalloonTip(2500);
    }

    // Runs a scan behind the splash window. Used for the first scan and for every
    // retry from the failure dialog.
    static bool ScanWithSplash(out string output)
    {
        Splash sp = new Splash();
        sp.Show();
        Application.DoEvents();
        try { return RunScan(out output); }
        finally { sp.Close(); sp.Dispose(); }
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

    // Tray 退出 used to leave the dashboard window sitting there: the launcher
    // process ended, but the window belongs to Chrome, not to us. "退出" on the
    // only UI the program has should take that UI with it.
    static void QuitApp()
    {
        // Stop the watchers first. Otherwise the window vanishing below looks
        // exactly like the user closing it, and OnWindowWatchTick would pop the
        // "keep it in the tray?" question on the way out.
        if (WindowWatch != null) WindowWatch.Stop();
        if (Poll != null) Poll.Stop();
        if (Debounce != null) Debounce.Stop();

        IntPtr h = FindDashboardWindow();
        if (h != IntPtr.Zero)
        {
            SaveGeometry(h);
            // PostMessage, not SendMessage: we are not waiting on another
            // process's message loop to finish tearing a window down.
            if (OwnAppWindow) PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }
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

    const string REPO = "Lianzy-Baimiao/WowAltBoard";

    /// <summary>
    /// Ask GitHub for the latest release tag. Returns "" and sets `err` on failure.
    ///
    /// Done here rather than by re-running the scan: the scan walks the whole WoW
    /// folder and takes the better part of a minute, which is why clicking
    /// 检查更新 used to look like it did nothing at all. This is one HTTPS request.
    /// </summary>
    static string FetchLatestTag(out string err, out string pageUrl)
    {
        err = ""; pageUrl = "";
        try
        {
            // .NET Framework defaults to TLS 1.0, which GitHub refuses outright.
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                "https://api.github.com/repos/" + REPO + "/releases/latest");
            req.UserAgent = "WowAltBoard";           // GitHub rejects requests without one
            req.Accept = "application/vnd.github+json";
            req.Timeout = 8000;
            req.ReadWriteTimeout = 8000;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                string json = sr.ReadToEnd();
                pageUrl = Grab(json, "html_url");
                return Grab(json, "tag_name");
            }
        }
        catch (Exception ex) { err = ex.Message; return ""; }
    }

    /// The version this copy actually is, taken from the last scan's output.
    static string InstalledVersion()
    {
        try
        {
            string js = File.ReadAllText(Path.Combine(BaseDir, "data\\data.js"), Encoding.UTF8);
            string v = Grab(js, "toolVersion");
            if (!string.IsNullOrEmpty(v)) return "v" + v.TrimStart('v', 'V');
        }
        catch { }
        return "";
    }

    /// <summary>
    /// Manual update check from the tray menu.
    ///
    /// Two things were wrong before: it ran a FULL rescan (tens of seconds) with
    /// no indication anything was happening, and it reported through a balloon
    /// tip -- which Windows 10/11 routinely swallows entirely (Focus Assist, or
    /// notifications turned off for the app). Between the two, the honest user
    /// experience was "I clicked it and nothing ever happened".
    ///
    /// Now: a splash appears immediately, the check is one HTTPS call, and the
    /// answer is a dialog the user cannot miss.
    /// </summary>
    static void CheckUpdate()
    {
        string latest, err, pageUrl;
        Splash sp = new Splash(T_UPDCHECKING);
        sp.Show();
        Application.DoEvents();                  // paint it before we block
        try { latest = FetchLatestTag(out err, out pageUrl); }
        finally { sp.Close(); sp.Dispose(); }

        string current = InstalledVersion();
        if (!string.IsNullOrEmpty(pageUrl)) UpdateUrl = pageUrl;
        string fallbackUrl = "https://github.com/" + REPO + "/releases";

        if (string.IsNullOrEmpty(latest))
        {
            if (MessageBox.Show(string.Format(T_UPDFAILASK, err), T_UPDTITLE,
                                MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
            {
                OpenUrl(string.IsNullOrEmpty(UpdateUrl) ? fallbackUrl : UpdateUrl);
            }
            return;
        }

        if (!string.IsNullOrEmpty(current) && IsNewer(latest, current))
        {
            if (MessageBox.Show(string.Format(T_UPDNEWERASK, latest, current), T_UPDTITLE,
                                MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
            {
                OpenUrl(string.IsNullOrEmpty(UpdateUrl) ? fallbackUrl : UpdateUrl);
            }
            return;
        }

        MessageBox.Show(string.Format(T_UPDNONEW, latest), T_UPDTITLE,
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
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
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr procId);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint attachTo, uint attachFrom, bool attach);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool BringWindowToTop(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);


    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr param);

    const int SW_RESTORE = 9;
    const int SW_SHOW = 5;
    const int SW_SHOWMAXIMIZED = 3;
    const uint WM_CLOSE = 0x0010;

    /// <summary>
    /// Force a window to the front.
    ///
    /// A bare SetForegroundWindow is not enough here: Windows refuses it unless
    /// the calling process already owns the foreground, and when the user
    /// double-clicks the exe from an Explorer window it is Explorer that owns it.
    /// That is why the dashboard came up BEHIND the folder. Attaching our input
    /// queue to the current foreground thread lifts the restriction for the
    /// duration of the call.
    /// </summary>
    static void ForceForeground(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return;
        try
        {
            if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
            else ShowWindow(hWnd, SW_SHOW);

            IntPtr fore = GetForegroundWindow();
            if (fore == hWnd) return;

            uint foreThread = GetWindowThreadProcessId(fore, IntPtr.Zero);
            uint thisThread = GetCurrentThreadId();
            bool attached = false;
            if (foreThread != 0 && foreThread != thisThread)
            {
                attached = AttachThreadInput(foreThread, thisThread, true);
            }
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
            if (attached) AttachThreadInput(foreThread, thisThread, false);
        }
        catch { /* cosmetic only -- never worth failing the launch over */ }
    }

    // Held for the process lifetime so it is not collected; a released mutex
    // would let a second instance through.
    static Mutex Single;

    /// The dashboard window handle, or IntPtr.Zero.
    static IntPtr FindDashboardWindow()
    {        IntPtr found = IntPtr.Zero;
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
        ForceForeground(found);
        return true;
    }


    /// <summary>
    /// Put the window back where it was last time.
    ///
    /// --window-position/--window-size only apply when the browser process we
    /// start is the one that creates the window. If that browser is ALREADY
    /// running, our command line is handed to the existing instance and the flags
    /// are ignored -- which is exactly what started happening once the launcher
    /// began preferring the user's default browser, since that one is usually
    /// already open. So place it ourselves instead of asking the browser to.
    /// </summary>
    static void RestoreGeometry(IntPtr hWnd)
    {
        try
        {
            if (!File.Exists(GeometryFile)) return;
            string[] p = File.ReadAllText(GeometryFile).Trim().Split(' ');
            if (p.Length < 4) return;
            int x, y, w, h;
            if (!int.TryParse(p[0], out x) || !int.TryParse(p[1], out y) ||
                !int.TryParse(p[2], out w) || !int.TryParse(p[3], out h)) return;
            if (w < 300 || h < 200) return;

            // A monitor that is gone would put the window out of reach.
            System.Drawing.Rectangle vs = SystemInformation.VirtualScreen;
            if (x + w < vs.Left + 80 || x > vs.Right - 80 ||
                y + h < vs.Top + 80 || y > vs.Bottom - 80) return;

            if (p.Length > 4 && p[4] == "1") { ShowWindow(hWnd, SW_SHOWMAXIMIZED); return; }
            SetWindowPos(hWnd, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        }
        catch { }
    }

    /// <summary>
    /// Raise the dashboard window as soon as the browser has created it.
    ///
    /// Process.Start returns immediately; the window does not exist yet, so
    /// there is nothing to raise at that point. Polling on a background thread
    /// keeps the tray UI responsive. Explorer holds the foreground when the exe
    /// is double-clicked from a folder, which is what put the window behind it.
    /// </summary>
    static void RaiseWhenReady()
    {
        Thread t = new Thread(delegate()
        {
            // ~6 s total: a cold browser start is slow, but waiting forever would
            // mean stealing focus long after the user moved on to something else.
            for (int i = 0; i < 40; i++)
            {
                Thread.Sleep(150);
                IntPtr h = FindDashboardWindow();
                if (h != IntPtr.Zero)
                {
                    // Place it before raising it, so it does not visibly jump.
                    RestoreGeometry(h);
                    ForceForeground(h);
                    return;
                }
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    // ------------------------------------------------------------- browser

    // Chrome/Edge --app= gives a chromeless window with its own taskbar entry,
    // so the dashboard looks like a standalone program while still running on a
    // real Chromium engine. There is no runtime to install: the WebView2 SDK is
    // not redistributable from here, and the old WebBrowser control is IE11,
    // which cannot render this page (CSS variables, flex gap, position sticky).
    static string FindBrowser()
    {
        // The user's default browser comes first. The page is hosted by whatever
        // browser we pick, and every link it opens lands in that same browser --
        // so preferring Chrome here is what made links open in Chrome on a
        // machine where the default was Edge.
        string preferred = DefaultChromiumBrowser();
        if (preferred != null) return preferred;

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

    /// Chromium-based engines understand --app=. Firefox does not, so a Firefox
    /// default falls through to the list above and keeps the chromeless window.
    static readonly string[] ChromiumExes = new string[] {
        "chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe",
        "chromium.exe", "thorium.exe", "yandex.exe", "360chrome.exe"
    };

    /// <summary>
    /// The default https handler, if it is Chromium-based.
    /// Returns null for Firefox, a missing association, or anything unparsable.
    /// </summary>
    static string DefaultChromiumBrowser()
    {
        try
        {
            string progId = null;
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice"))
            {
                if (k != null)
                {
                    object v = k.GetValue("ProgId");
                    if (v != null) progId = v.ToString();
                }
            }
            if (string.IsNullOrEmpty(progId)) return null;

            string cmd = null;
            using (RegistryKey k = Registry.ClassesRoot.OpenSubKey(
                progId + @"\shell\open\command"))
            {
                if (k != null)
                {
                    object v = k.GetValue("");
                    if (v != null) cmd = v.ToString();
                }
            }
            if (string.IsNullOrEmpty(cmd)) return null;

            string exe = ExeFromCommand(cmd);
            if (exe == null || !File.Exists(exe)) return null;

            string name = Path.GetFileName(exe).ToLowerInvariant();
            foreach (string ok in ChromiumExes) if (name == ok) return exe;
            return null;
        }
        catch { return null; }
    }

    /// Pull the executable path out of a registry "open command" string, which
    /// is usually quoted and always followed by argument placeholders like "%1".
    static string ExeFromCommand(string cmd)
    {
        cmd = cmd.Trim();
        if (cmd.StartsWith("\""))
        {
            int end = cmd.IndexOf('"', 1);
            if (end > 1) return cmd.Substring(1, end - 1);
            return null;
        }
        int sp = cmd.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
        if (sp >= 0) return cmd.Substring(0, sp + 4);
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
                // Recorded so 退出 knows it may close that window: an --app= window
                // holds nothing but our page. The fallback below may well be a tab
                // in the user's own browser window, and closing THAT would take
                // their other tabs with it -- so the flag stays false there.
                OwnAppWindow = true;
                RaiseWhenReady();
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
            Fail(T_NOBROWSE, ex.Message);
        }
    }

    // ------------------------------------------------------- game directory

    // A folder picker beats telling the user to hand-edit JSON, and it is the
    // only part of the config that ever needs changing on a machine where
    // auto-detection fails.
    //
    // Returns true when a path was saved. Rescanning is the caller's business:
    // this is reachable both from the tray menu and from the failure dialog, and
    // those two want different things to happen next.
    static bool PickGameDir()
    {
        FolderBrowserDialog dlg = new FolderBrowserDialog();
        dlg.Description = T_PICKDIR;
        dlg.ShowNewFolderButton = false;
        if (dlg.ShowDialog() != DialogResult.OK) return false;

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
            return false;
        }

        return WriteWowPath(chosen);
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

            Notify(T_SHORTCUTOK);
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
        SetTrayText(T_TRAYBUSY);
        try
        {
            while (true)
            {
                string output;
                bool ok = RunScan(out output);
                SetTrayText(T_TRAYIDLE);
                if (ok) break;
                // A background rescan that fails is almost always "the game is
                // mid-write"; the next poll picks it up. Never pop a dialog for it.
                if (!interactive) return;
                if (FailScan(output) != DialogResult.Retry) return;
                SetTrayText(T_TRAYBUSY);
            }
            // Re-baseline, or the poll would fire again on the same change.
            foreach (string f in WatchFiles) LastSeen[f] = Stamp(f);

            Notify(T_TRAYDONE);
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
        Single = new Mutex(true, "Local\\WowAltBoard.SingleInstance", out isFirst);
        if (!isFirst)
        {
            if (!FocusDashboard() && File.Exists(PageFile)) OpenDashboard();
            return 0;
        }

        // The failure dialog offers a retry, because most of the fixes it
        // suggests (install the addon, log in, /reload) are done while it is on
        // screen. Making the user relaunch the exe afterwards would be rude.
        string firstOutput;
        while (!ScanWithSplash(out firstOutput))
        {
            if (FailScan(firstOutput) != DialogResult.Retry) return 1;
        }
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
        menu.Items.Add(T_TRAYSETDIR, null, delegate(object s, EventArgs e)
        {
            if (!PickGameDir()) return;
            Notify(T_DIRSAVED);
            Rescan(true);
        });
        menu.Items.Add(T_TRAYSHORTCUT, null, delegate(object s, EventArgs e) { CreateDesktopShortcut(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(T_TRAYEXIT, null, delegate(object s, EventArgs e) { QuitApp(); });
        Tray.ContextMenuStrip = menu;
        Tray.DoubleClick += delegate(object s, EventArgs e) { OpenDashboard(); };
        Tray.BalloonTipClicked += delegate(object s, EventArgs e)
        {
            if (!string.IsNullOrEmpty(UpdateUrl)) OpenUrl(UpdateUrl);
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
    Write-Host 'Done. Double-click "魔兽看板.exe" to use it.' -ForegroundColor Green
} else {
    Write-Host '  build produced no file' -ForegroundColor Red
    exit 1
}

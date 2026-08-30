<#
  WowAltBoard - scan.ps1
  Discovers WoW installs, reads every AlterEgo.lua SavedVariables file, and emits
  data/data.js for the local dashboard.

  Deliberate design notes (see plan):
    * This script does NO Lua parsing. It only finds files, reads bytes, and
      escapes them into a JS string. All parsing happens in app/lua-parser.js.
    * Output is UTF-8 WITH BOM on purpose: file:// has no Content-Type header, so
      a BOM makes data.js self-describing regardless of the referencing document.
    * All console output is ASCII. The Windows console codepage here is 936 and
      Chinese text in a .bat/.ps1 pipeline mangles. Chinese lives in the HTML.
    * ConvertTo-Json is used for string escaping. It is fast (~13ms for 250KB),
      lossless, leaves CJK as literal codepoints, and escapes '<' to \u003c so a
      "</script>" inside item descriptions can never break out of the script tag.

  PowerShell 5.1 constraints observed throughout:
    * 'if' is NOT an expression -- it cannot appear in an argument position.
      Only $( ... ) subexpressions may contain statements.
    * [System.IO.File]::Move(src, dst, overwrite) does not exist on .NET Framework.
    * Out-File/Set-Content -Encoding UTF8 always emit a BOM; use [IO.File] directly.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$SCHEMA_VERSION = 1
$TOOL_VERSION   = '1.13.2'
$REPO           = 'Lianzy-Baimiao/WowAltBoard'
$AUTHOR         = '白描'

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
$ToolsDir = $PSScriptRoot
if (-not $ToolsDir) { $ToolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$BaseDir  = Split-Path -Parent $ToolsDir
$DataDir  = Join-Path $BaseDir 'data'
$HistDir  = Join-Path $DataDir 'history'

function Write-Step { param([string]$m) Write-Host "  $m" }
function Write-Warn { param([string]$m) Write-Host "  ! $m" -ForegroundColor Yellow }

# Distinguishes "we detected a situation and want to explain it" from "the script
# crashed". Only the latter is worth printing a stack trace for.
#
# -Code is what the GUI launcher keys its Chinese explanation off. The English
# text below is the console/.bat audience; the launcher never shows it as the
# headline, because "no AlterEgo.lua in any account's SavedVariables" tells a
# player nothing about what to actually do. Codes are emitted as
# "SCAN_ERROR=<code>" plus optional "SCAN_DATA=<key>=<value>" lines so the
# launcher can parse them out of stdout without a second channel.
$script:FriendlyError = $false
$script:ErrorCode     = ''
$script:ErrorData     = @{}
function Stop-Friendly {
    param(
        [Parameter(Mandatory)][string]$Message,
        [string]$Code = 'UNKNOWN',
        [hashtable]$Data
    )
    $script:FriendlyError = $true
    $script:ErrorCode     = $Code
    if ($Data) { $script:ErrorData = $Data }
    throw $Message
}

Write-Host ''
Write-Host "WowAltBoard scanner v$TOOL_VERSION"
Write-Host ('-' * 62)

foreach ($d in @($DataDir, $HistDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
$ConfigPath = Join-Path $ToolsDir 'config.json'
$Config = [pscustomobject]@{
    wowPaths                 = @()
    excludeAccounts          = @()
    accountAliases           = [pscustomobject]@{}
    historyWeeksToKeep       = 12
    absorbDownloadedSettings = $true
    checkForUpdates          = $true
    collectBackups           = $true
    readBagSync              = $true
    includeFlavors           = @('_retail_')
}
if (Test-Path -LiteralPath $ConfigPath) {
    try {
        $raw  = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.UTF8Encoding]::new($false))
        $user = $raw | ConvertFrom-Json
        foreach ($p in $user.PSObject.Properties) {
            $Config | Add-Member -MemberType NoteProperty -Name $p.Name -Value $p.Value -Force
        }
        Write-Step 'config.json loaded'
    } catch {
        # The exception text can embed the whole file; keep the console readable.
        $msg = ($_.Exception.Message -split "`r?`n")[0]
        if ($msg.Length -gt 120) { $msg = $msg.Substring(0, 120) + '...' }
        Write-Warn "config.json is not valid JSON, using defaults ($msg)"
        Write-Warn "  check tools\config.json -- backslashes must be doubled, e.g. E:\\World of Warcraft"
    }
}

# Look up a key on either a Hashtable (our defaults) or a PSCustomObject (from JSON).
function Get-MapValue {
    param($Map, [string]$Key)
    if ($null -eq $Map) { return $null }
    if ($Map -is [System.Collections.IDictionary]) {
        if ($Map.Contains($Key)) { return $Map[$Key] }
        return $null
    }
    $prop = $Map.PSObject.Properties[$Key]
    if ($prop) { return $prop.Value }
    return $null
}

# --------------------------------------------------------------------------
# File IO helpers
# --------------------------------------------------------------------------

# Read UTF-8 text tolerating a concurrent writer (WoW rewrites SavedVariables on
# logout/reload). FileShare.ReadWrite gets us past the writer's lock; it does NOT
# guarantee a consistent snapshot, hence Test-LuaComplete below.
function Read-SharedUtf8 {
    param([Parameter(Mandatory)][string]$Path)
    $fs = [System.IO.FileStream]::new(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite)
    try {
        $sr = [System.IO.StreamReader]::new($fs, [System.Text.UTF8Encoding]::new($false), $true)
        try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
    } finally { $fs.Dispose() }
}

# Cheap structural check: did we read a whole file, or a half-written one?
# Balances braces while skipping quoted strings.
function Test-LuaComplete {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    $t = $Text.TrimEnd()
    if (-not $t.EndsWith('}')) { return $false }
    $depth = 0; $inStr = $false; $esc = $false
    foreach ($c in $t.ToCharArray()) {
        if ($esc) { $esc = $false; continue }
        if ($c -eq '\') { if ($inStr) { $esc = $true }; continue }
        if ($c -eq '"') { $inStr = -not $inStr; continue }
        if ($inStr) { continue }
        if     ($c -eq '{') { $depth++ }
        elseif ($c -eq '}') { $depth-- }
        if ($depth -lt 0) { return $false }
    }
    return ($depth -eq 0)
}

# Read a SavedVariables file, falling back to WoW's .bak if the live file is
# mid-write. Returns $null when neither is usable.
function Read-SavedVariable {
    param([Parameter(Mandatory)][string]$Path)
    foreach ($p in @($Path, ($Path + '.bak'))) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        try {
            $text = Read-SharedUtf8 $p
            if (Test-LuaComplete $text) {
                return [pscustomobject]@{
                    Text     = $text
                    UsedPath = $p
                    Degraded = ($p -ne $Path)
                }
            }
        } catch {
            # fall through to the next candidate
        }
    }
    return $null
}

# Lone surrogates would serialize to invalid UTF-8. WoW strings are byte strings,
# so a truncated multi-byte sequence is reachable in principle.
function Remove-LoneSurrogates {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $pattern = '[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]'
    if ($Text -match $pattern) {
        return [regex]::Replace($Text, $pattern, [string][char]0xFFFD)
    }
    return $Text
}

# JSON string literal, including the surrounding quotes.
function ConvertTo-JsString {
    param([Parameter(Mandatory)][AllowEmptyString()][AllowNull()]$Text)
    if ($null -eq $Text) { return '""' }
    return (Remove-LoneSurrogates ([string]$Text)) | ConvertTo-Json -Compress
}

# Atomic UTF-8 (with BOM) write.
function Write-JsFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Content
    )
    $abs = [System.IO.Path]::GetFullPath($Path)
    $tmp = $abs + '.tmp'
    # UTF8Encoding($true) => emit BOM. Intentional, see header comment.
    [System.IO.File]::WriteAllText($tmp, $Content, [System.Text.UTF8Encoding]::new($true))
    Move-Item -LiteralPath $tmp -Destination $abs -Force
}

# --------------------------------------------------------------------------
# WoW install discovery
# --------------------------------------------------------------------------

# A "flavor dir" is _retail_ / _classic_ / _ptr_ ... containing WTF and Interface.
# Note the -ErrorAction: with $ErrorActionPreference='Stop', Test-Path against a
# drive letter that does not exist THROWS rather than returning false, so a typo
# like "Z:\wow" in config.json would crash the script instead of being ignored.
function Test-FlavorDir {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        return (Test-Path -LiteralPath (Join-Path $Path 'WTF') -ErrorAction SilentlyContinue) -and
               (Test-Path -LiteralPath (Join-Path $Path 'Interface') -ErrorAction SilentlyContinue)
    } catch { return $false }
}

# Which game flavours to read. Retail only by default: that is what the addon
# targets, and pulling in a _classic_ / _ptr_ install would add characters the
# user is not asking about. An empty list means "all of them".
function Get-FlavorDirs {
    param([Parameter(Mandatory)][string]$RootPath)
    $all = @(Get-ChildItem -LiteralPath $RootPath -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -like '_*_' })
    $want = @($Config.includeFlavors)
    if ($want.Count -eq 0) { return $all }
    return @($all | Where-Object { $want -contains $_.Name })
}

function Get-WowRoots {
    $found = New-Object System.Collections.ArrayList

    function Add-Root {
        param([string]$Path, [string]$Via)
        if ([string]::IsNullOrWhiteSpace($Path)) { return }
        try { $Path = [System.IO.Path]::GetFullPath($Path.TrimEnd('\', '/')) } catch { return }
        try {
            if (-not (Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue)) { return }
        } catch { return }
        foreach ($e in $found) { if ($e.path -eq $Path) { return } }
        # Only accept a directory that actually contains a flavor dir.
        $flavors = @(Get-ChildItem -LiteralPath $Path -Directory -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -like '_*_' -and (Test-FlavorDir $_.FullName) })
        if ($flavors.Count -eq 0) { return }
        [void]$found.Add([pscustomobject]@{ path = $Path; via = $Via })
    }

    # 1. Manual override wins outright.
    foreach ($p in @($Config.wowPaths)) {
        if (-not $p) { continue }
        $before = $found.Count
        if (Test-FlavorDir $p) { Add-Root (Split-Path -Parent $p) 'config.json' }
        else                   { Add-Root $p 'config.json' }
        # Silently ignoring a typo here would look like the tool auto-detected
        # correctly when it actually ignored what the user asked for.
        if ($found.Count -eq $before) {
            Write-Warn "config.json wowPaths entry is not a World of Warcraft folder, ignoring: $p"
        }
    }
    if ($found.Count -gt 0) { return $found.ToArray() }

    # 2. Walk up from the tool's own location (works when dropped inside WoW).
    $cur = $BaseDir
    for ($i = 0; $i -lt 8 -and $cur; $i++) {
        if (Test-FlavorDir $cur) { Add-Root (Split-Path -Parent $cur) 'walk-up'; break }
        $parent = Split-Path -Parent $cur
        if (-not $parent -or $parent -eq $cur) { break }
        $cur = $parent
    }

    # 3. Registry. InstallPath points at the flavor dir, so take its parent.
    $regKeys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Blizzard Entertainment\World of Warcraft',
        'HKLM:\SOFTWARE\Blizzard Entertainment\World of Warcraft',
        'HKCU:\SOFTWARE\Blizzard Entertainment\World of Warcraft'
    )
    foreach ($k in $regKeys) {
        try {
            if (-not (Test-Path -LiteralPath $k)) { continue }
            $ip = (Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue).InstallPath
            if (-not $ip) { continue }
            $ip = $ip.TrimEnd('\', '/')
            if (Test-FlavorDir $ip) { Add-Root (Split-Path -Parent $ip) 'registry' }
            else                    { Add-Root $ip 'registry' }
        } catch { }
    }

    # 4. Battle.net launcher config.
    try {
        $bnet = Join-Path $env:APPDATA 'Battle.net\Battle.net.config'
        if (Test-Path -LiteralPath $bnet) {
            $txt = [System.IO.File]::ReadAllText($bnet, [System.Text.UTF8Encoding]::new($false))
            foreach ($m in [regex]::Matches($txt, '"(?:InstallPath|DefaultInstallPath|Path)"\s*:\s*"([^"]+)"')) {
                $cand = $m.Groups[1].Value.Replace('\\', '\').Replace('\/', '/')
                Add-Root $cand 'battle.net'
                Add-Root (Join-Path $cand 'World of Warcraft') 'battle.net'
            }
        }
    } catch { }

    if ($found.Count -gt 0) { return $found.ToArray() }

    # 5. Last resort: shallow probe of common locations. Never a recursive scan --
    #    a WoW install can sit next to multi-GB archives.
    Write-Step 'nothing found yet, probing common locations...'
    $drives = @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
                Where-Object { $null -ne $_.Free } | Select-Object -ExpandProperty Root)
    $suffixes = @(
        'World of Warcraft',
        'Games\World of Warcraft',
        'Program Files (x86)\World of Warcraft',
        'Program Files\World of Warcraft',
        'Battle.net\World of Warcraft',
        'Blizzard\World of Warcraft'
    )
    foreach ($d in $drives) {
        foreach ($s in $suffixes) { Add-Root (Join-Path $d $s) 'probe' }
    }
    return $found.ToArray()
}

# --------------------------------------------------------------------------
# Source enumeration
# --------------------------------------------------------------------------

# file:// URLs treat '#' as a fragment delimiter, and one account folder here is
# literally named "123456789#3". Filenames and DOM ids get the sanitized form;
# the original survives as displayName.
function Get-SafeId {
    param([Parameter(Mandatory)][string]$Text)
    $safe = [regex]::Replace($Text, '[^A-Za-z0-9_-]', '_')
    if ($safe -eq $Text) { return $safe }
    # Guard against two different accounts colliding after sanitizing.
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
        $hex   = ([System.BitConverter]::ToString($bytes) -replace '-', '').Substring(0, 6).ToLower()
        return "$safe`_$hex"
    } finally { $md5.Dispose() }
}

function Get-AlterEgoSources {
    param([Parameter(Mandatory)]$Roots)

    $sources = New-Object System.Collections.ArrayList
    $errors  = New-Object System.Collections.ArrayList
    $exclude = @($Config.excludeAccounts)

    foreach ($root in $Roots) {
        $flavorDirs = @(Get-FlavorDirs -RootPath $root.path)
        foreach ($flavor in $flavorDirs) {
            $acctRoot = Join-Path $flavor.FullName 'WTF\Account'
            # A stub flavor dir can have no WTF at all.
            if (-not (Test-Path -LiteralPath $acctRoot)) { continue }

            # 'SavedVariables' sits at account level but is NOT an account.
            $acctDirs = @(Get-ChildItem -LiteralPath $acctRoot -Directory -ErrorAction SilentlyContinue |
                          Where-Object { $_.Name -ne 'SavedVariables' })
            foreach ($acct in $acctDirs) {
                if ($exclude -contains $acct.Name) { continue }
                $svPath = Join-Path $acct.FullName 'SavedVariables\AlterEgo.lua'
                if (-not (Test-Path -LiteralPath $svPath)) { continue }

                $res = Read-SavedVariable $svPath
                if (-not $res) {
                    [void]$errors.Add([pscustomobject]@{
                        path    = $svPath
                        message = 'file was incomplete or unreadable, and no usable .bak existed'
                    })
                    Write-Warn "unreadable: $($acct.Name)"
                    continue
                }

                $item  = Get-Item -LiteralPath $res.UsedPath
                $alias = Get-MapValue $Config.accountAliases $acct.Name
                $display = $acct.Name
                if ($alias) { $display = [string]$alias }

                [void]$sources.Add([pscustomobject]@{
                    id          = Get-SafeId $acct.Name
                    account     = $acct.Name
                    displayName = $display
                    flavor      = $flavor.Name
                    wowRoot     = $root.path
                    path        = $svPath
                    usedPath    = $res.UsedPath
                    degraded    = $res.Degraded
                    size        = $item.Length
                    mtime       = [int64]([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeSeconds()
                    mtimeLocal  = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
                    lua         = $res.Text
                })

                $tag = ''
                if ($res.Degraded) { $tag = '  [degraded: used .bak]' }
                Write-Step ('{0,-16} {1,6:N0} KB  {2}{3}' -f `
                    $acct.Name, ($item.Length / 1KB), $item.LastWriteTime.ToString('MM-dd HH:mm'), $tag)
            }
        }
    }
    return [pscustomobject]@{ sources = $sources; errors = $errors }
}

# --------------------------------------------------------------------------
# Why is there no data?
# --------------------------------------------------------------------------
# "Found WoW, but no AlterEgo.lua" has at least five different causes and five
# different fixes -- addon never installed, unpacked one folder too deep,
# installed but unticked, game never logged in, or logged in but never saved.
# Telling them apart costs a few directory listings, and it is the difference
# between the launcher saying "go install the addon" and the user staring at a
# log. Runs only on the failure path, so the cost never shows up in a good scan.
#
# Addon enable state lives per character in
#   WTF\Account\<account>\<Realm>\<Character>\AddOns.txt
# as lines like "AlterEgo: enabled". There is no account-wide file to check.
function Get-NoDataDiagnosis {
    param([Parameter(Mandatory)]$Roots)

    $addonsDir = ''      # first Interface\AddOns we saw -- where to unpack into
    $addonPath = ''      # the AlterEgo folder, if it exists at all
    $hasToc    = $false
    $chars     = 0
    $enabled   = 0
    $disabled  = 0

    foreach ($root in $Roots) {
        foreach ($flavor in @(Get-FlavorDirs -RootPath $root.path)) {
            $ad = Join-Path $flavor.FullName 'Interface\AddOns'
            if (-not $addonsDir) { $addonsDir = $ad }

            $ae = Join-Path $ad 'AlterEgo'
            if (Test-Path -LiteralPath $ae) {
                if (-not $addonPath) { $addonPath = $ae }
                if (Test-Path -LiteralPath (Join-Path $ae 'AlterEgo.toc')) { $hasToc = $true }
            }

            $acctRoot = Join-Path $flavor.FullName 'WTF\Account'
            if (-not (Test-Path -LiteralPath $acctRoot)) { continue }
            $acctDirs = @(Get-ChildItem -LiteralPath $acctRoot -Directory -ErrorAction SilentlyContinue |
                          Where-Object { $_.Name -ne 'SavedVariables' })
            foreach ($acct in $acctDirs) {
                # Two levels down, explicitly: -Recurse would also walk
                # SavedVariables and the per-character cache files for nothing.
                foreach ($realm in @(Get-ChildItem -LiteralPath $acct.FullName -Directory -ErrorAction SilentlyContinue)) {
                    foreach ($char in @(Get-ChildItem -LiteralPath $realm.FullName -Directory -ErrorAction SilentlyContinue)) {
                        $f = Join-Path $char.FullName 'AddOns.txt'
                        if (-not (Test-Path -LiteralPath $f)) { continue }
                        $chars++
                        try {
                            $txt = [System.IO.File]::ReadAllText($f, [System.Text.UTF8Encoding]::new($false))
                        } catch { continue }
                        $m = [regex]::Match($txt, '(?im)^\s*AlterEgo\s*:\s*(\w+)\s*$')
                        if (-not $m.Success) { continue }
                        if ($m.Groups[1].Value -ieq 'enabled') { $enabled++ } else { $disabled++ }
                    }
                }
            }
        }
    }

    if (-not $addonsDir) { $addonsDir = '(Interface\AddOns)' }
    return [pscustomobject]@{
        addonsDir = $addonsDir
        addonPath = $addonPath
        hasToc    = $hasToc
        chars     = $chars
        enabled   = $enabled
        disabled  = $disabled
    }
}

# Turns the diagnosis into (code, one-line English summary, hint). The launcher
# uses the code; the console shows the text.
function Get-NoDataVerdict {
    param([Parameter(Mandatory)]$Diag, [int]$UnreadableCount = 0)

    if ($UnreadableCount -gt 0) {
        return [pscustomobject]@{
            code = 'SV_UNREADABLE'
            text = 'Found AlterEgo.lua, but every copy was incomplete or unreadable.'
            hint = 'Fully exit World of Warcraft (not just log out) and run this again.'
        }
    }
    if (-not $Diag.addonPath) {
        return [pscustomobject]@{
            code = 'NO_ADDON'
            text = 'The AlterEgo addon is not installed.'
            hint = "Unpack it into $($Diag.addonsDir), then log a character in and /reload."
        }
    }
    if (-not $Diag.hasToc) {
        return [pscustomobject]@{
            code = 'ADDON_BROKEN'
            text = 'An AlterEgo folder exists but has no AlterEgo.toc, so the game never loads it.'
            hint = 'Usually one nested folder too many: AddOns\AlterEgo\AlterEgo\AlterEgo.toc.'
        }
    }
    if ($Diag.chars -eq 0) {
        return [pscustomobject]@{
            code = 'NO_CHARACTER'
            text = 'This World of Warcraft folder has no character data at all.'
            hint = 'Either the wrong install was picked, or nobody has logged in here yet.'
        }
    }
    if ($Diag.enabled -eq 0 -and $Diag.disabled -gt 0) {
        return [pscustomobject]@{
            code = 'ADDON_DISABLED'
            text = 'AlterEgo is installed but disabled for every character.'
            hint = 'Tick it in the AddOns list at the character select screen.'
        }
    }
    return [pscustomobject]@{
        code = 'NO_SAVEDVARS'
        text = 'AlterEgo is installed and enabled, but has never written its SavedVariables.'
        hint = 'Log a character in, then /reload or exit the game -- that is when it saves.'
    }
}

# --------------------------------------------------------------------------
# Addon's own lookup tables
# --------------------------------------------------------------------------
# Embedding these means season -> challengeModeID -> abbr/name, raid lists, and
# vault item levels update automatically whenever the user updates the addon,
# instead of being hand-maintained in labels.js.
function Get-AddonTables {
    param([Parameter(Mandatory)]$Roots)
    $wanted = @('MythicPlus.lua', 'Raids.lua', 'Seasons.lua', 'Vault.lua',
                'Currencies.lua', 'Inventory.lua', 'Prey.lua', 'UpgradeTracks.lua')
    $tables  = @{}
    $version = ''
    foreach ($root in $Roots) {
        $flavorDirs = @(Get-FlavorDirs -RootPath $root.path)
        foreach ($flavor in $flavorDirs) {
            $addonDir = Join-Path $flavor.FullName 'Interface\AddOns\AlterEgo'
            if (-not (Test-Path -LiteralPath $addonDir)) { continue }

            if (-not $version) {
                $toc = Join-Path $addonDir 'AlterEgo.toc'
                if (Test-Path -LiteralPath $toc) {
                    try {
                        $tocText = [System.IO.File]::ReadAllText($toc, [System.Text.UTF8Encoding]::new($false))
                        $m = [regex]::Match($tocText, '(?m)^##\s*Version:\s*(.+?)\s*$')
                        if ($m.Success) { $version = $m.Groups[1].Value }
                    } catch { }
                }
            }
            foreach ($w in $wanted) {
                if ($tables.ContainsKey($w)) { continue }
                $f = Join-Path $addonDir "Data\$w"
                if (-not (Test-Path -LiteralPath $f)) { continue }
                try { $tables[$w] = [System.IO.File]::ReadAllText($f, [System.Text.UTF8Encoding]::new($false)) } catch { }
            }
        }
    }
    return [pscustomobject]@{ tables = $tables; addonVersion = $version }
}

# --------------------------------------------------------------------------
# Settings write-back: absorb a settings.js the user downloaded from the page
# --------------------------------------------------------------------------
function Get-DownloadsFolder {
    try {
        $k = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
        $v = (Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'
        if ($v) { return [Environment]::ExpandEnvironmentVariables($v) }
    } catch { }
    return (Join-Path $env:USERPROFILE 'Downloads')
}

function Get-EmbeddedSavedAt {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    # Narrow regex only. This file lives in a world-writable directory and must
    # never be executed just to read its timestamp.
    $m = [regex]::Match($Text, '"savedAt"\s*:\s*(\d+)')
    if ($m.Success) { return [int64]$m.Groups[1].Value }
    return 0
}

function Import-DownloadedSettings {
    if (-not $Config.absorbDownloadedSettings) { return }
    $dl = Get-DownloadsFolder
    if (-not (Test-Path -LiteralPath $dl)) { return }

    $target = Join-Path $DataDir 'settings.js'
    $bestAt = 0
    if (Test-Path -LiteralPath $target) {
        try { $bestAt = Get-EmbeddedSavedAt ([System.IO.File]::ReadAllText($target, [System.Text.UTF8Encoding]::new($false))) } catch { }
    }

    # Chromium renames repeat downloads to "settings (1).js", so glob and pick by
    # embedded savedAt rather than by filename or mtime.
    $best = $null
    foreach ($f in @(Get-ChildItem -LiteralPath $dl -Filter 'settings*.js' -File -ErrorAction SilentlyContinue)) {
        try {
            $t = [System.IO.File]::ReadAllText($f.FullName, [System.Text.UTF8Encoding]::new($false))
            if ($t -notmatch 'AE_SETTINGS') { continue }
            $at = Get-EmbeddedSavedAt $t
            if ($at -gt $bestAt) { $bestAt = $at; $best = $f }
        } catch { }
    }

    if ($best) {
        Copy-Item -LiteralPath $best.FullName -Destination $target -Force
        Write-Step "absorbed newer settings from Downloads\$($best.Name)"
    }
}

# --------------------------------------------------------------------------
# Weekly history snapshots
# --------------------------------------------------------------------------
# Snapshots are keyed by the WoW weekly-reset epoch, NOT by ISO week. WoW's
# reset is not Monday-midnight local, so an ISO week label would split one game
# week across two files and merge two others into one -- every weekly delta then
# comes out silently wrong.
#
# `global.weeklyReset` exists exactly once per file (there is no nested key of
# that name in AlterEgo's schema), so a narrow regex is safe here. Everything
# else in this script stays parser-free; real Lua parsing happens in the browser.
function Get-WeeklyResetKey {
    param([Parameter(Mandatory)]$Sources)
    $best = 0
    foreach ($s in $Sources) {
        $m = [regex]::Match($s.lua, '\["weeklyReset"\]\s*=\s*(\d+)')
        if ($m.Success) {
            $v = [int64]$m.Groups[1].Value
            if ($v -gt $best) { $best = $v }
        }
    }
    return $best
}

# The snapshot stores raw Lua, so one parser serves both the live view and the
# history view. Cost is ~0.6 MB per retained week; historyWeeksToKeep bounds it.
# The browser distills these into a few numbers per character and caches the
# result, and it only loads them when the trend view is opened.
function Write-HistorySnapshot {
    param(
        [Parameter(Mandatory)]$Sources,
        [Parameter(Mandatory)][int64]$WeekKey
    )
    if ($WeekKey -le 0) {
        Write-Warn 'could not determine the weekly reset time; skipping the history snapshot'
        return
    }

    $file = Join-Path $HistDir ("$WeekKey.js")
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('// WowAltBoard weekly snapshot. Generated -- do not edit.')
    [void]$sb.AppendLine('window.AE_HISTORY = window.AE_HISTORY || [];')
    [void]$sb.AppendLine('window.AE_HISTORY.push({')
    [void]$sb.AppendLine("  week: $WeekKey,")
    [void]$sb.AppendLine("  capturedAt: $([int64]([DateTimeOffset]::UtcNow).ToUnixTimeSeconds()),")
    [void]$sb.AppendLine('  sources: [')
    foreach ($s in $Sources) {
        [void]$sb.AppendLine('    {')
        [void]$sb.AppendLine("      id: $(ConvertTo-JsString $s.id),")
        [void]$sb.AppendLine("      displayName: $(ConvertTo-JsString $s.displayName),")
        [void]$sb.AppendLine("      lua: $(ConvertTo-JsString $s.lua),")
        [void]$sb.AppendLine('    },')
    }
    [void]$sb.AppendLine('  ],')
    [void]$sb.AppendLine('});')

    # Rewritten in place for the whole week, so the stored state is the latest
    # one before the reset -- which is the state a weekly view wants.
    Write-JsFile -Path $file -Content $sb.ToString()

    $keep = [int]$Config.historyWeeksToKeep
    if ($keep -lt 1) { $keep = 1 }
    $all = @(Get-ChildItem -LiteralPath $HistDir -Filter '*.js' -File -ErrorAction SilentlyContinue |
             Where-Object { $_.BaseName -match '^\d+$' } |
             Sort-Object { [int64]$_.BaseName } -Descending)
    if ($all.Count -gt $keep) {
        foreach ($old in $all[$keep..($all.Count - 1)]) {
            Remove-Item -LiteralPath $old.FullName -Force -ErrorAction SilentlyContinue
        }
        $all = $all[0..($keep - 1)]
    }

    $mb = New-Object System.Text.StringBuilder
    [void]$mb.AppendLine('// WowAltBoard history index. Metadata only -- the snapshots')
    [void]$mb.AppendLine('// themselves are loaded on demand when the trend view is opened.')
    [void]$mb.AppendLine('window.AE_MANIFEST = { history: [')
    foreach ($f in ($all | Sort-Object { [int64]$_.BaseName })) {
        $wk = [int64]$f.BaseName
        $label = [DateTimeOffset]::FromUnixTimeSeconds($wk).ToLocalTime().ToString('yyyy-MM-dd')
        [void]$mb.AppendLine("  { week: $wk, file: $(ConvertTo-JsString ('history/' + $f.Name)), " +
                             "label: $(ConvertTo-JsString $label), size: $($f.Length) },")
    }
    [void]$mb.AppendLine('] };')
    Write-JsFile -Path (Join-Path $DataDir 'manifest.js') -Content $mb.ToString()

    $totalMb = (($all | Measure-Object Length -Sum).Sum) / 1MB
    Write-Step ('week {0}, {1} snapshots kept, {2:N1} MB total' -f $WeekKey, $all.Count, $totalMb)
}

# --------------------------------------------------------------------------
# BagSync: professions
# --------------------------------------------------------------------------
# AlterEgo does not track professions -- there is no profession field anywhere in
# its SavedVariables, and its source only mentions Professions for the crafted-
# quality star icons. BagSync does: BagSyncDB[realm][character].professions holds
# every skill line with its localized name and per-expansion skill levels, and
# its per-character `guid` is the same Player-707-XXXXXXXX key AlterEgo uses, so
# the two join without matching on name+realm.
#
# This is OPTIONAL by design. No BagSync means no file here, which means the
# profession columns simply never exist -- the tool is still an AlterEgo
# dashboard first. Set readBagSync=false in config.json to skip it outright.
#
# Emitted to its own data/bagsync.js rather than folded into data.js: these files
# are 14-165 KB each (mostly bag/bank/mail contents we do not care about) and
# keeping them out of data.js means a user without BagSync pays nothing.
function Get-BagSyncSources {
    param([Parameter(Mandatory)]$Roots)

    $out     = New-Object System.Collections.ArrayList
    $exclude = @($Config.excludeAccounts)

    foreach ($root in $Roots) {
        foreach ($flavor in @(Get-FlavorDirs -RootPath $root.path)) {
            $acctRoot = Join-Path $flavor.FullName 'WTF\Account'
            if (-not (Test-Path -LiteralPath $acctRoot)) { continue }
            $acctDirs = @(Get-ChildItem -LiteralPath $acctRoot -Directory -ErrorAction SilentlyContinue |
                          Where-Object { $_.Name -ne 'SavedVariables' })
            foreach ($acct in $acctDirs) {
                if ($exclude -contains $acct.Name) { continue }
                $p = Join-Path $acct.FullName 'SavedVariables\BagSync.lua'
                if (-not (Test-Path -LiteralPath $p)) { continue }

                # Read-SavedVariable, not Read-SharedUtf8: same mid-write hazard
                # as AlterEgo.lua, same .bak fallback worth having.
                $res = Read-SavedVariable $p
                if (-not $res) { Write-Warn "BagSync.lua unreadable: $($acct.Name)"; continue }

                $item = Get-Item -LiteralPath $res.UsedPath
                [void]$out.Add([pscustomobject]@{
                    id         = Get-SafeId $acct.Name
                    account    = $acct.Name
                    path       = $p
                    size       = $item.Length
                    mtime      = [int64]([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeSeconds()
                    mtimeLocal = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
                    lua        = $res.Text
                })
                Write-Step ('{0,-16} {1,6:N0} KB  {2}' -f `
                    $acct.Name, ($item.Length / 1KB), $item.LastWriteTime.ToString('MM-dd HH:mm'))
            }
        }
    }
    return $out
}

# --------------------------------------------------------------------------
# Backup payloads: addon export strings worth keeping outside the game
# --------------------------------------------------------------------------
# MySlot stores its export strings verbatim in SavedVariables as
# MyslotExports.exports[] = {name, value}, so they are recoverable without the
# game running -- that is the useful case, since these are what you paste into a
# fresh install. The edit-mode cache is Blizzard's own binary-ish serialization:
# it cannot be pasted anywhere, but keeping a copy lets you restore the file.
function Get-BackupSources {
    param([Parameter(Mandatory)]$Roots)

    $wanted = @(
        @{ kind = 'lua';  file = 'SavedVariables\Myslot.lua';        label = 'MySlot' },
        @{ kind = 'text'; file = 'edit-mode-cache-account.txt';      label = 'EditMode' }
    )

    $out = New-Object System.Collections.ArrayList
    foreach ($root in $Roots) {
        $flavorDirs = @(Get-FlavorDirs -RootPath $root.path)
        foreach ($flavor in $flavorDirs) {
            $acctRoot = Join-Path $flavor.FullName 'WTF\Account'
            if (-not (Test-Path -LiteralPath $acctRoot)) { continue }
            $acctDirs = @(Get-ChildItem -LiteralPath $acctRoot -Directory -ErrorAction SilentlyContinue |
                          Where-Object { $_.Name -ne 'SavedVariables' })
            foreach ($acct in $acctDirs) {
                foreach ($w in $wanted) {
                    $p = Join-Path $acct.FullName $w.file
                    if (-not (Test-Path -LiteralPath $p)) { continue }
                    try {
                        $text = Read-SharedUtf8 $p
                    } catch { continue }
                    if ([string]::IsNullOrWhiteSpace($text)) { continue }
                    $item = Get-Item -LiteralPath $p
                    [void]$out.Add([pscustomobject]@{
                        id         = (Get-SafeId $acct.Name) + '_' + $w.label
                        label      = $w.label
                        kind       = $w.kind
                        account    = $acct.Name
                        path       = $p
                        size       = $item.Length
                        mtimeLocal = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
                        content    = $text
                    })
                    Write-Step ('{0,-10} {1,-16} {2,6:N0} KB' -f $w.label, $acct.Name, ($item.Length / 1KB))
                }
            }
        }
    }
    return $out
}

# --------------------------------------------------------------------------
# Update check
# --------------------------------------------------------------------------
# Done here, not in the page: file:// blocks fetch/XHR outright, so the browser
# cannot reach the network at all. Only api.github.com is contacted, and nothing
# about the user or their data is sent. Set checkForUpdates=false in config.json
# to disable.
function Get-UpdateInfo {
    param([Parameter(Mandatory)][string]$Repo, [Parameter(Mandatory)][string]$CurrentVersion)

    $result = [pscustomobject]@{
        checked        = $false
        latestVersion  = ''
        currentVersion = $CurrentVersion
        url            = "https://github.com/$Repo"
        publishedAt    = ''
        error          = ''
    }
    if (-not $Config.checkForUpdates) {
        $result.error = 'disabled in config.json'
        return $result
    }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $api = "https://api.github.com/repos/$Repo/releases/latest"
        $r = Invoke-RestMethod -Uri $api -TimeoutSec 8 -UseBasicParsing `
                 -Headers @{ 'User-Agent' = 'WowAltBoard'; 'Accept' = 'application/vnd.github+json' }
        $result.checked = $true
        $result.latestVersion = [string]$r.tag_name
        if ($r.html_url) { $result.url = [string]$r.html_url }
        if ($r.published_at) { $result.publishedAt = [string]$r.published_at }
        Write-Step ("latest release: {0} (current {1})" -f $result.latestVersion, $CurrentVersion)
    } catch {
        # A missing repo, no releases yet, or no network are all normal. Never
        # let this fail the scan.
        $result.error = ($_.Exception.Message -split "`r?`n")[0]
        Write-Step 'update check skipped (no network or no release yet)'
    }
    return $result
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
try {
    Write-Host 'Locating World of Warcraft...'
    $roots = @(Get-WowRoots)
    if ($roots.Count -eq 0) {
        Stop-Friendly -Code 'NO_WOW' -Message (
               "No World of Warcraft installation found.`r`n" +
               "  Fix: edit tools\config.json and set wowPaths, for example:`r`n" +
               '    { "wowPaths": ["E:\\World of Warcraft"] }')
    }
    foreach ($r in $roots) { Write-Step "$($r.path)   (via $($r.via))" }

    Write-Host ''
    Write-Host 'Reading AlterEgo SavedVariables...'
    $scan = Get-AlterEgoSources -Roots $roots
    if ($scan.sources.Count -eq 0) {
        Write-Host ''
        Write-Host 'No data. Working out why...'
        $diag    = Get-NoDataDiagnosis -Roots $roots
        $verdict = Get-NoDataVerdict -Diag $diag -UnreadableCount $scan.errors.Count
        Stop-Friendly -Code $verdict.code -Data @{
            addonsDir = $diag.addonsDir
            addonPath = $diag.addonPath
            wowRoot   = $roots[0].path
        } -Message ($verdict.text + "`r`n  " + $verdict.hint)
    }

    Write-Host ''
    Write-Host 'Reading AlterEgo lookup tables...'
    $addon = Get-AddonTables -Roots $roots
    $verLabel = $addon.addonVersion
    if (-not $verLabel) { $verLabel = 'unknown' }
    Write-Step ('{0} tables, addon version {1}' -f $addon.tables.Count, $verLabel)

    Import-DownloadedSettings

    $backups = New-Object System.Collections.ArrayList
    if ($Config.collectBackups) {
        Write-Host ''
        Write-Host 'Collecting addon backup payloads...'
        $backups = Get-BackupSources -Roots $roots
        if ($backups.Count -eq 0) { Write-Step 'none found' }
    }

    $bagSync = New-Object System.Collections.ArrayList
    if ($Config.readBagSync) {
        Write-Host ''
        Write-Host 'Looking for BagSync (professions)...'
        $bagSync = Get-BagSyncSources -Roots $roots
        if ($bagSync.Count -eq 0) { Write-Step 'not installed -- profession columns will be off' }
    }

    Write-Host ''
    Write-Host 'Checking for updates...'
    $update = Get-UpdateInfo -Repo $REPO -CurrentVersion $TOOL_VERSION

    # ---- emit data/data.js -------------------------------------------------
    Write-Host ''
    Write-Host 'Writing data/data.js...'

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('// Generated by tools/scan.ps1 -- do not edit by hand.')
    [void]$sb.AppendLine('// Regenerate by double-clicking the launcher in the folder above.')
    [void]$sb.AppendLine('window.AE_DATA = {')
    [void]$sb.AppendLine("  schema: $SCHEMA_VERSION,")
    [void]$sb.AppendLine("  toolVersion: $(ConvertTo-JsString $TOOL_VERSION),")
    [void]$sb.AppendLine("  scannedAt: $([int64]([DateTimeOffset]::UtcNow).ToUnixTimeSeconds()),")
    [void]$sb.AppendLine("  scannedAtLocal: $(ConvertTo-JsString (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),")
    [void]$sb.AppendLine("  addonVersion: $(ConvertTo-JsString $addon.addonVersion),")
    [void]$sb.AppendLine("  author: $(ConvertTo-JsString $AUTHOR),")
    # The page cannot discover where the browser saves downloads, so tell it.
    [void]$sb.AppendLine("  downloadsDir: $(ConvertTo-JsString (Get-DownloadsFolder)),")
    [void]$sb.AppendLine("  repo: $(ConvertTo-JsString $REPO),")
    [void]$sb.AppendLine('  update: {')
    [void]$sb.AppendLine("    checked: $(if ($update.checked) { 'true' } else { 'false' }),")
    [void]$sb.AppendLine("    currentVersion: $(ConvertTo-JsString $update.currentVersion),")
    [void]$sb.AppendLine("    latestVersion: $(ConvertTo-JsString $update.latestVersion),")
    [void]$sb.AppendLine("    url: $(ConvertTo-JsString $update.url),")
    [void]$sb.AppendLine("    publishedAt: $(ConvertTo-JsString $update.publishedAt),")
    [void]$sb.AppendLine("    error: $(ConvertTo-JsString $update.error),")
    [void]$sb.AppendLine('  },')

    [void]$sb.AppendLine('  backupIndex: [')
    foreach ($b in $backups) {
        # Index only. The payloads themselves go to data/backups.js, which the
        # page loads on demand -- the MySlot strings alone are ~440 KB here and
        # there is no reason to parse them on every page load.
        [void]$sb.AppendLine('    {')
        [void]$sb.AppendLine("      id: $(ConvertTo-JsString $b.id),")
        [void]$sb.AppendLine("      label: $(ConvertTo-JsString $b.label),")
        [void]$sb.AppendLine("      kind: $(ConvertTo-JsString $b.kind),")
        [void]$sb.AppendLine("      account: $(ConvertTo-JsString $b.account),")
        [void]$sb.AppendLine("      path: $(ConvertTo-JsString $b.path),")
        [void]$sb.AppendLine("      size: $($b.size),")
        [void]$sb.AppendLine("      mtimeLocal: $(ConvertTo-JsString $b.mtimeLocal),")
        [void]$sb.AppendLine('    },')
    }
    [void]$sb.AppendLine('  ],')

    [void]$sb.AppendLine('  wowRoots: [')
    foreach ($r in $roots) {
        [void]$sb.AppendLine("    { path: $(ConvertTo-JsString $r.path), via: $(ConvertTo-JsString $r.via) },")
    }
    [void]$sb.AppendLine('  ],')

    # Metadata only -- the payloads are in data/bagsync.js. `enabled` is what lets
    # the page tell "BagSync is not installed" (offer the download) apart from
    # "you switched it off in config.json" (say nothing).
    [void]$sb.AppendLine('  bagSync: {')
    [void]$sb.AppendLine("    enabled: $(if ($Config.readBagSync) { 'true' } else { 'false' }),")
    [void]$sb.AppendLine("    accounts: $($bagSync.Count),")
    [void]$sb.AppendLine('  },')

    [void]$sb.AppendLine('  addonTables: {')
    foreach ($k in ($addon.tables.Keys | Sort-Object)) {
        [void]$sb.AppendLine("    $(ConvertTo-JsString $k): $(ConvertTo-JsString $addon.tables[$k]),")
    }
    [void]$sb.AppendLine('  },')

    [void]$sb.AppendLine('  errors: [')
    foreach ($e in $scan.errors) {
        [void]$sb.AppendLine("    { path: $(ConvertTo-JsString $e.path), message: $(ConvertTo-JsString $e.message) },")
    }
    [void]$sb.AppendLine('  ],')

    [void]$sb.AppendLine('  sources: [')
    foreach ($s in $scan.sources) {
        $degraded = 'false'
        if ($s.degraded) { $degraded = 'true' }
        [void]$sb.AppendLine('    {')
        [void]$sb.AppendLine("      id: $(ConvertTo-JsString $s.id),")
        [void]$sb.AppendLine("      account: $(ConvertTo-JsString $s.account),")
        [void]$sb.AppendLine("      displayName: $(ConvertTo-JsString $s.displayName),")
        [void]$sb.AppendLine("      flavor: $(ConvertTo-JsString $s.flavor),")
        [void]$sb.AppendLine("      wowRoot: $(ConvertTo-JsString $s.wowRoot),")
        [void]$sb.AppendLine("      path: $(ConvertTo-JsString $s.path),")
        [void]$sb.AppendLine("      usedPath: $(ConvertTo-JsString $s.usedPath),")
        [void]$sb.AppendLine("      degraded: $degraded,")
        [void]$sb.AppendLine("      size: $($s.size),")
        [void]$sb.AppendLine("      mtime: $($s.mtime),")
        [void]$sb.AppendLine("      mtimeLocal: $(ConvertTo-JsString $s.mtimeLocal),")
        [void]$sb.AppendLine("      lua: $(ConvertTo-JsString $s.lua),")
        [void]$sb.AppendLine('    },')
    }
    [void]$sb.AppendLine('  ],')
    [void]$sb.AppendLine('};')

    $dataPath = Join-Path $DataDir 'data.js'
    Write-JsFile -Path $dataPath -Content $sb.ToString()
    $outSize = (Get-Item -LiteralPath $dataPath).Length
    Write-Step ('{0} sources, {1:N0} KB written' -f $scan.sources.Count, ($outSize / 1KB))

    # Ensure this exists so index.html can load it unconditionally.
    $settingsPath = Join-Path $DataDir 'settings.js'
    if (-not (Test-Path -LiteralPath $settingsPath)) {
        Write-JsFile -Path $settingsPath -Content "window.AE_SETTINGS = null;`r`n"
    }

    # ---- emit data/bagsync.js (professions; loaded eagerly, may be empty) ----
    # Always written, even when empty, so index.html can load it unconditionally
    # the way it already does for settings.js and manifest.js.
    $gb = New-Object System.Text.StringBuilder
    [void]$gb.AppendLine('// BagSync SavedVariables, read for the profession columns.')
    [void]$gb.AppendLine('// Optional: empty when BagSync is not installed. Generated -- do not edit.')
    [void]$gb.AppendLine('window.AE_BAGSYNC = [')
    foreach ($g in $bagSync) {
        [void]$gb.AppendLine('  {')
        [void]$gb.AppendLine("    id: $(ConvertTo-JsString $g.id),")
        [void]$gb.AppendLine("    account: $(ConvertTo-JsString $g.account),")
        [void]$gb.AppendLine("    path: $(ConvertTo-JsString $g.path),")
        [void]$gb.AppendLine("    size: $($g.size),")
        [void]$gb.AppendLine("    mtime: $($g.mtime),")
        [void]$gb.AppendLine("    mtimeLocal: $(ConvertTo-JsString $g.mtimeLocal),")
        [void]$gb.AppendLine("    lua: $(ConvertTo-JsString $g.lua),")
        [void]$gb.AppendLine('  },')
    }
    [void]$gb.AppendLine('];')
    Write-JsFile -Path (Join-Path $DataDir 'bagsync.js') -Content $gb.ToString()
    $gbSize = (Get-Item -LiteralPath (Join-Path $DataDir 'bagsync.js')).Length
    Write-Step ('bagsync.js: {0} accounts, {1:N0} KB' -f $bagSync.Count, ($gbSize / 1KB))

    # ---- emit data/backups.js (lazy-loaded by the page) --------------------
    $bb = New-Object System.Text.StringBuilder
    [void]$bb.AppendLine('// Addon export strings and config backups. Generated -- do not edit.')
    [void]$bb.AppendLine('window.AE_BACKUPS = [')
    foreach ($b in $backups) {
        [void]$bb.AppendLine('  {')
        [void]$bb.AppendLine("    id: $(ConvertTo-JsString $b.id),")
        [void]$bb.AppendLine("    label: $(ConvertTo-JsString $b.label),")
        [void]$bb.AppendLine("    kind: $(ConvertTo-JsString $b.kind),")
        [void]$bb.AppendLine("    account: $(ConvertTo-JsString $b.account),")
        [void]$bb.AppendLine("    path: $(ConvertTo-JsString $b.path),")
        [void]$bb.AppendLine("    size: $($b.size),")
        [void]$bb.AppendLine("    mtimeLocal: $(ConvertTo-JsString $b.mtimeLocal),")
        [void]$bb.AppendLine("    content: $(ConvertTo-JsString $b.content),")
        [void]$bb.AppendLine('  },')
    }
    [void]$bb.AppendLine('];')
    Write-JsFile -Path (Join-Path $DataDir 'backups.js') -Content $bb.ToString()
    $bkSize = (Get-Item -LiteralPath (Join-Path $DataDir 'backups.js')).Length
    Write-Step ('backups.js: {0} payloads, {1:N0} KB' -f $backups.Count, ($bkSize / 1KB))

    # ---- emit data/watch.txt ----------------------------------------------
    # Plain text, one directory per line: the launcher watches these for changes
    # so a /reload in game triggers a rescan. A text file rather than parsing
    # data.js from C#.
    $watchDirs = New-Object System.Collections.Specialized.StringCollection
    foreach ($s in $scan.sources) {
        $d = Split-Path -Parent $s.path
        if (-not $watchDirs.Contains($d)) { [void]$watchDirs.Add($d) }
    }
    $watchText = (@($watchDirs) -join "`r`n")
    # No BOM here: this one is read by the launcher's File.ReadAllLines, not by
    # the browser, and a stray BOM on the first path is an avoidable trap.
    $watchAbs = [System.IO.Path]::GetFullPath((Join-Path $DataDir 'watch.txt'))
    [System.IO.File]::WriteAllText($watchAbs, $watchText + "`r`n", [System.Text.UTF8Encoding]::new($false))

    Write-Host ''
    Write-Host 'Writing weekly history snapshot...'
    $weekKey = Get-WeeklyResetKey -Sources $scan.sources
    Write-HistorySnapshot -Sources $scan.sources -WeekKey $weekKey

    $manifestPath = Join-Path $DataDir 'manifest.js'
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Write-JsFile -Path $manifestPath -Content "window.AE_MANIFEST = { history: [] };`r`n"
    }

    Write-Host ''
    Write-Host 'Done.' -ForegroundColor Green
    exit 0

} catch {
    Write-Host ''
    # Machine-readable first, so the launcher can find it even if the human text
    # below grows. Values are forced onto one line each.
    $code = $script:ErrorCode
    if (-not $script:FriendlyError -or -not $code) { $code = 'UNKNOWN' }
    Write-Host "SCAN_ERROR=$code"
    foreach ($k in @($script:ErrorData.Keys)) {
        $v = ([string]$script:ErrorData[$k]) -replace '[\r\n]+', ' '
        if ($v) { Write-Host "SCAN_DATA=$k=$v" }
    }
    Write-Host ''
    Write-Host 'SCAN FAILED' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (-not $script:FriendlyError -and $_.ScriptStackTrace) {
        Write-Host ''
        Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    }
    exit 1
}

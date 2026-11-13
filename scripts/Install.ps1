[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\install-common.ps1')

$roots = Get-NotifyRoots
Assert-NotifyScopedPath $roots.Program $roots.Local
$release = Read-NotifyRelease $PSScriptRoot
$codex = Get-NotifyCodexCli
$market = Find-NotifyMarketplace $codex
if ($market -and !(Test-NotifyMarketplacePath $market $roots.Program)) {
    throw 'A different local source already owns the codex-notify-windows catalog. Review it in Codex before installing.'
}

if (Test-Path -LiteralPath $roots.Program) {
    $installed = Read-NotifyRelease $roots.Program
    throw 'Uninstall the existing version first, even for a rebuilt package with the same version. Settings and history are kept by default. Then install the new package.'
} else {
    $null = New-Item -ItemType Directory -Path $roots.Programs -Force
    # Keep the staging path no longer than the final path for Windows PowerShell's file provider.
    $stage = Join-Path $roots.Programs ('cn-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    Assert-NotifyScopedPath $stage $roots.Programs
    try {
        $null = New-Item -ItemType Directory -Path $stage
        foreach ($relative in @('.agents', 'dist', 'licenses', 'node_modules', 'plugin', 'scripts', 'codex-notify.cmd', 'codex-notify-release.json', 'Install.ps1', 'Uninstall.ps1', 'package.json', 'question-rules.json', 'README.md')) {
            $entry = Get-Item -LiteralPath (Join-Path $PSScriptRoot $relative) -Force
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to install a linked package entry.' }
            if ($entry.PSIsContainer) { Assert-NotifyTree $entry.FullName }
            Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $stage $relative) -Recurse -Force
        }
        Assert-NotifyScopedPath $roots.Program $roots.Programs
        Move-Item -LiteralPath $stage -Destination $roots.Program
    } finally {
        Remove-NotifyTree $stage $roots.Programs
    }
}

if (!$market) {
    $added = Invoke-NotifyCodexJson $codex @('plugin', 'marketplace', 'add', $roots.Program, '--json')
    if ($added.marketplaceName -ne $NotifyMarketplace) { throw 'Codex returned an unexpected marketplace name.' }
}

Write-Output "Codex Notify $($release.version) installed at $($roots.Program)."
Write-Output 'In Codex Desktop, refresh or reopen Plugins, install Codex Notify from codex-notify-windows, and review and trust its registration hooks.'
Write-Output ('Then run: & "' + (Join-Path $roots.Program 'codex-notify.cmd') + '" init')

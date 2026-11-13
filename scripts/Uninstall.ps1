[CmdletBinding()]
param([switch] $PurgeData)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\install-common.ps1')

$roots = Get-NotifyRoots
Assert-NotifyScopedPath $roots.Program $roots.Local
if (!(Test-Path -LiteralPath $roots.Program -PathType Container)) { throw 'Codex Notify is not installed for this Windows user.' }
$null = Read-NotifyRelease $roots.Program
Assert-NotifyTree $roots.Program
if ($PurgeData) {
    Assert-NotifyScopedPath $roots.Data $roots.Local
    if (Test-Path -LiteralPath $roots.Data) { Assert-NotifyTree $roots.Data }
}

$node = Join-Path $roots.Program 'plugin\runtime\node.exe'
$cli = Join-Path $roots.Program 'dist\src\runtime\cli.js'
& $node $cli disable
if ($LASTEXITCODE -ne 0) { throw 'Codex Notify could not stop or remove login startup. Program and data files were kept.' }

$codex = Get-NotifyCodexCli
$market = Find-NotifyMarketplace $codex
if ($market -and !(Test-NotifyMarketplacePath $market $roots.Program)) {
    throw 'The configured catalog points elsewhere. Review it in Codex before uninstalling.'
}
$null = Invoke-NotifyCodexJson $codex @('plugin', 'remove', $NotifyPlugin, '--json')
if ($market) { $null = Invoke-NotifyCodexJson $codex @('plugin', 'marketplace', 'remove', $NotifyMarketplace, '--json') }

Set-Location -LiteralPath $roots.Local
Remove-NotifyTree $roots.Program $roots.Local
if ($PurgeData) {
    Remove-NotifyTree $roots.Data $roots.Local
    Write-Output 'Codex Notify and its local data were removed.'
} else {
    Write-Output "Codex Notify was removed. Settings and history remain at $($roots.Data)."
}

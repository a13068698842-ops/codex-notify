$NotifyMarketplace = 'codex-notify-windows'
$NotifyPlugin = 'codex-notify@codex-notify-windows'

function Get-NotifyRoots {
    if (!$env:LOCALAPPDATA -or ![IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA must be an absolute path.' }
    $local = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
    $programs = Join-Path $local 'Programs'
    [pscustomobject]@{ Local = $local; Programs = $programs; Program = (Join-Path $programs 'CodexNotify'); Data = (Join-Path $local 'CodexNotify') }
}

function Assert-NotifyScopedPath([string] $Path, [string] $Parent) {
    $full = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + '\'
    if (!$full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to touch a directory outside the expected parent.' }
    for ($check = $full; $check; $check = [IO.Path]::GetDirectoryName($check)) {
        if (Test-Path -LiteralPath $check) {
            $item = Get-Item -LiteralPath $check -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to touch a linked path.' }
        }
    }
}

function Assert-NotifyTree([string] $Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Container)) { throw 'Expected a directory.' }
    $remaining = New-Object 'System.Collections.Generic.Stack[string]'
    $remaining.Push($Path)
    while ($remaining.Count) {
        foreach ($entry in Get-ChildItem -LiteralPath $remaining.Pop() -Force) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to touch a tree containing a linked path.' }
            if ($entry.PSIsContainer) { $remaining.Push($entry.FullName) }
        }
    }
}

function Remove-NotifyTree([string] $Path, [string] $Parent) {
    Assert-NotifyScopedPath $Path $Parent
    if (Test-Path -LiteralPath $Path) {
        Assert-NotifyTree $Path
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Read-NotifyRelease([string] $Path) {
    $marker = Join-Path $Path 'codex-notify-release.json'
    if (!(Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'The directory does not contain a Codex Notify release.' }
    $release = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($release.name -ne 'codex-notify' -or $release.layout -ne 1 -or $release.architecture -ne 'win-x64' -or
        $release.marketplace -ne $NotifyMarketplace -or $release.version -notmatch '^\d+\.\d+\.\d+$') {
        throw 'The Codex Notify release manifest is invalid.'
    }
    return $release
}

function Get-NotifyCodexCli {
    $package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
    if ($package) {
        $candidate = Join-Path $package.InstallLocation 'app\resources\codex.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $running = Get-Process -Name codex -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\'), [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if ($running) { return $running.Path }
    $command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    throw 'Install Codex Desktop for this Windows user, then run this script again.'
}

function Invoke-NotifyCodexJson([string] $Cli, [string[]] $Arguments) {
    $result = & $Cli @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Codex could not complete: ' + ($Arguments[0..2] -join ' ')) }
    return ($result -join "`n") | ConvertFrom-Json
}

function Find-NotifyMarketplace([string] $Cli) {
    $list = Invoke-NotifyCodexJson $Cli @('plugin', 'marketplace', 'list', '--json')
    return $list.marketplaces | Where-Object { $_.name -eq $NotifyMarketplace } | Select-Object -First 1
}

function Test-NotifyMarketplacePath($Marketplace, [string] $Expected) {
    if (!$Marketplace -or !$Marketplace.root) { return $false }
    $root = [string] $Marketplace.root
    if ($root.StartsWith('\\?\')) { $root = $root.Substring(4) }
    return [string]::Equals([IO.Path]::GetFullPath($root).TrimEnd('\'), [IO.Path]::GetFullPath($Expected).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

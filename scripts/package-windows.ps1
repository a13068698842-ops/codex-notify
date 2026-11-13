[CmdletBinding()]
param(
    [string] $NodeArchive,
    [string] $Proxy,
    [switch] $Offline,
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-common.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Find-BuildProxy {
    if ($Proxy) { return $Proxy }
    if ($env:HTTPS_PROXY) { return $env:HTTPS_PROXY }
    if ($env:HTTP_PROXY) { return $env:HTTP_PROXY }
    if ($env:ALL_PROXY) { return $env:ALL_PROXY }
    $settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    if ($settings.PSObject.Properties['AutoConfigURL'] -and $settings.AutoConfigURL) { throw 'PAC is not supported for packaging. Supply -Proxy or use -Offline and -NodeArchive.' }
    if (!$settings.ProxyEnable -or !$settings.ProxyServer) { return $null }
    $endpoint = [string] $settings.ProxyServer
    if ($endpoint.Contains('=')) {
        $configured = @{}
        foreach ($segment in $endpoint.Split(';')) {
            $parts = $segment.Split('=', 2)
            if ($parts.Count -eq 2) { $configured[$parts[0].Trim()] = $parts[1].Trim() }
        }
        $endpoint = if ($configured['https']) { $configured['https'] } else { $configured['http'] }
        if (!$endpoint) { throw 'No HTTP proxy is configured for packaging. Supply -Proxy or use -Offline and -NodeArchive.' }
    }
    if ($endpoint -notmatch '^[a-z]+://') { $endpoint = 'http://' + $endpoint }
    return $endpoint
}

$repository = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
$nodeVersion = '24.18.0'
$nodeFilename = "node-v$nodeVersion-win-x64.zip"
$nodeArchiveHash = '0AE68406B42D7725661DA979B1403EC9926DA205C6770827F33AAC9D8F26E821'
$nodeExeHash = '9A4EB5F1C29C6A2E93852EAD46B999E284A6A5CA8BAB4D4E241D587D025A52DE'
if ($version -notmatch '^\d+\.\d+\.\d+$' -or $package.engines.node -ne $nodeVersion) { throw 'Update the pinned runtime and checksum for the requested version.' }
if ((node --version) -ne "v$nodeVersion") { throw "Build requires Node $nodeVersion." }
if ($Offline -and !$NodeArchive) { throw 'Offline packaging requires -NodeArchive pointing to the pinned official Windows x64 ZIP.' }
if ($NodeArchive) { $NodeArchive = (Resolve-Path -LiteralPath $NodeArchive).ProviderPath }
$releases = if ($OutputDirectory) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory) }
    else { Join-Path $repository 'dist\releases' }
$null = New-Item -ItemType Directory -Path $releases -Force
$stage = Join-Path $releases ('build-' + [Guid]::NewGuid().ToString('N'))
Assert-NotifyScopedPath $stage $releases
$archive = Join-Path $releases "codex-notify-$version-win-x64.zip"
$archiveTemporary = "$stage.zip"
$previousProxy = $env:npm_config_https_proxy
try {
    $bundle = Join-Path $stage 'bundle'
    $null = New-Item -ItemType Directory -Path $bundle -Force
    if (!$Offline) {
        $effectiveProxy = Find-BuildProxy
        if ($effectiveProxy) {
            $uri = $null
            if (![Uri]::TryCreate($effectiveProxy, [UriKind]::Absolute, [ref] $uri) -or $uri.Scheme -notin @('http', 'https')) { throw 'Packaging requires an HTTP or HTTPS proxy.' }
            $env:npm_config_https_proxy = $effectiveProxy
        }
    }
    if (!$NodeArchive) {
        $NodeArchive = Join-Path $stage $nodeFilename
        $download = @{ Uri = "https://nodejs.org/dist/v$nodeVersion/$nodeFilename"; OutFile = $NodeArchive; UseBasicParsing = $true; TimeoutSec = 120 }
        if ($effectiveProxy) { $download.Proxy = $effectiveProxy }
        Invoke-WebRequest @download
    }
    if ((Get-FileHash -LiteralPath $NodeArchive -Algorithm SHA256).Hash -ne $nodeArchiveHash) { throw 'The Node runtime ZIP failed its pinned SHA-256 check.' }
    $nodeRoot = Join-Path $stage 'node'
    [IO.Compression.ZipFile]::ExtractToDirectory($NodeArchive, $nodeRoot)
    $nodeSource = Join-Path $nodeRoot "node-v$nodeVersion-win-x64"
    $nodeExe = Join-Path $nodeSource 'node.exe'
    if ((Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash -ne $nodeExeHash) { throw 'The extracted Node executable failed its pinned SHA-256 check.' }

    # TypeScript does not remove outputs for deleted sources. Use a fresh build
    # directory so the ZIP cannot pick up stale files from the development tree.
    $compiled = Join-Path $stage 'compiled'
    Push-Location -LiteralPath $repository
    try {
        & npm.cmd run build -- --outDir $compiled
        if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    } finally { Pop-Location }

    foreach ($relative in @('package.json', 'package-lock.json', 'question-rules.json', 'plugin', '.agents')) {
        Copy-Item -LiteralPath (Join-Path $repository $relative) -Destination (Join-Path $bundle $relative) -Force -Recurse
    }
    foreach ($file in @('Install.ps1', 'Uninstall.ps1', 'codex-notify.cmd')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $bundle $file)
    }
    foreach ($folder in @('dist', 'scripts', 'licenses', 'plugin\runtime')) {
        $null = New-Item -ItemType Directory -Path (Join-Path $bundle $folder)
    }
    Copy-Item -LiteralPath (Join-Path $compiled 'src') -Destination (Join-Path $bundle 'dist\src') -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-common.ps1'), (Join-Path $PSScriptRoot 'setup-window.ps1') -Destination (Join-Path $bundle 'scripts')
    Copy-Item -LiteralPath (Join-Path $repository 'docs\WINDOWS_INSTALL.md') -Destination (Join-Path $bundle 'README.md')
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $bundle 'plugin\runtime\node.exe')
    Copy-Item -LiteralPath (Join-Path $nodeSource 'LICENSE') -Destination (Join-Path $bundle 'licenses\Node-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $repository 'src\vendor\codex-mobile\LICENSE') -Destination (Join-Path $bundle 'licenses\codex-mobile-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $repository 'src\vendor\codex-mobile\UPSTREAM.md') -Destination (Join-Path $bundle 'licenses\codex-mobile-UPSTREAM.md')
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $marketPath = Join-Path $bundle '.agents\plugins\marketplace.json'
    $market = Get-Content -LiteralPath $marketPath -Raw | ConvertFrom-Json
    $market.name = $NotifyMarketplace
    [IO.File]::WriteAllText($marketPath, ($market | ConvertTo-Json -Depth 20) + "`n", $utf8)
    $hooksPath = Join-Path $bundle 'plugin\hooks\hooks.json'
    $hooks = Get-Content -LiteralPath $hooksPath -Raw | ConvertFrom-Json
    foreach ($rule in @($hooks.hooks.SessionStart) + @($hooks.hooks.UserPromptSubmit)) {
        foreach ($handler in $rule.hooks) {
            $handler.commandWindows = 'cmd.exe /d /s /c %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${PLUGIN_ROOT}\scripts\register.ps1"'
            $handler.command = $handler.commandWindows
            $handler.timeout = 3
        }
    }
    [IO.File]::WriteAllText($hooksPath, ($hooks | ConvertTo-Json -Depth 20) + "`n", $utf8)
    $marker = [ordered]@{ name = 'codex-notify'; version = $version; layout = 1; architecture = 'win-x64'; marketplace = $NotifyMarketplace; nodeVersion = $nodeVersion }
    [IO.File]::WriteAllText((Join-Path $bundle 'codex-notify-release.json'), ($marker | ConvertTo-Json) + "`n", $utf8)

    $npmArguments = @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
    if ($Offline) { $npmArguments += '--offline' }
    Push-Location -LiteralPath $bundle
    try {
        & npm.cmd @npmArguments
        if ($LASTEXITCODE -ne 0) { throw 'Installing locked production dependencies failed.' }
    } finally { Pop-Location }
    # npm installs upstream test fixtures alongside some runtime packages.
    # Limit pruning to the standard fixture directories of locked packages.
    $dependencies = & node -e "for (const key of Object.keys(require(process.argv[1]).packages)) if (key) console.log(key)" (Join-Path $bundle 'package-lock.json')
    if ($LASTEXITCODE -ne 0) { throw 'Reading locked dependency paths failed.' }
    foreach ($entry in $dependencies) {
        if ($entry -notmatch '^node_modules/(?:@[\w.-]+/)?[\w.-]+(?:/node_modules/(?:@[\w.-]+/)?[\w.-]+)*$') { continue }
        $dependency = Join-Path $bundle $entry
        if (!(Test-Path -LiteralPath $dependency -PathType Container)) { continue }
        foreach ($fixture in @('test', 'tests', '__tests__', 'fixtures')) {
            $target = Join-Path $dependency $fixture
            if (Test-Path -LiteralPath $target -PathType Container) { Remove-NotifyTree $target $bundle }
        }
    }
    $experiments = Join-Path $bundle 'node_modules\qrcode-generator\experiment'
    if (Test-Path -LiteralPath $experiments -PathType Container) { Remove-NotifyTree $experiments $bundle }
    Remove-Item -LiteralPath (Join-Path $bundle 'package-lock.json') -Force
    Assert-NotifyTree $bundle
    [IO.Compression.ZipFile]::CreateFromDirectory($bundle, $archiveTemporary, [IO.Compression.CompressionLevel]::Optimal, $false)
    Move-Item -LiteralPath $archiveTemporary -Destination $archive -Force
    Get-FileHash -LiteralPath $archive -Algorithm SHA256
} finally {
    $env:npm_config_https_proxy = $previousProxy
    if (Test-Path -LiteralPath $archiveTemporary) { Remove-Item -LiteralPath $archiveTemporary -Force }
    Remove-NotifyTree $stage $releases
}

$ErrorActionPreference = 'Stop'

# Run from the Codex plugin cache. Copy stdin as bytes so a non-ASCII cwd survives Windows PowerShell.
$child = $null
try {
    if (!$env:LOCALAPPDATA -or !(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexNotify\control.json') -PathType Leaf)) { exit 0 }
    $node = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\node.exe'
    if (!(Test-Path -LiteralPath $node -PathType Leaf)) { exit 0 }
    $inputBytes = New-Object byte[] 65537
    $stdin = [Console]::OpenStandardInput()
    $length = 0
    while ($length -lt $inputBytes.Length) {
        $count = $stdin.Read($inputBytes, $length, ($inputBytes.Length - $length))
        if ($count -eq 0) { break }
        $length += $count
    }
    if ($length -eq 0 -or $length -eq $inputBytes.Length) { exit 0 }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node
    $startInfo.Arguments = '"' + (Join-Path $PSScriptRoot 'register.mjs') + '"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $child = [Diagnostics.Process]::Start($startInfo)
    $child.StandardInput.BaseStream.Write($inputBytes, 0, $length)
    $child.StandardInput.Close()
    if (!$child.WaitForExit(900)) { $child.Kill() }
} catch {
    # Missing/starting/stopped runtime must never interrupt the Codex turn.
} finally {
    if ($child) {
        if (!$child.HasExited) { $child.Kill() }
        $child.Dispose()
    }
}
exit 0

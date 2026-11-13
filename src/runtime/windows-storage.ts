import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import { windowsPowerShell, windowsPowerShellEnv } from './windows-powershell.js';

const transform = String.raw`
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Security
  $bytes = [IO.MemoryStream]::new()
  [Console]::OpenStandardInput().CopyTo($bytes)
  $inputBytes = $bytes.ToArray()
  $entropy = [Text.Encoding]::UTF8.GetBytes('CodexNotify.Feishu.v1')
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
`;

function transformCredential(bytes: Buffer, operation: 'Protect' | 'Unprotect'): Buffer {
  try {
    return execFileSync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `${transform}\n$output = [Security.Cryptography.ProtectedData]::${operation}($inputBytes, $entropy, $scope)\n` +
      '[Console]::OpenStandardOutput().Write($output, 0, $output.Length)'], {
      input: bytes, env: windowsPowerShellEnv(), windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { throw new Error('credential_protection_failed'); }
}

export function protectCredential(secret: string): Buffer {
  const bytes = Buffer.from(secret, 'utf8');
  try { return transformCredential(bytes, 'Protect'); } finally { bytes.fill(0); }
}

export function unprotectCredential(ciphertext: Buffer): string {
  const bytes = transformCredential(ciphertext, 'Unprotect');
  try { return bytes.toString('utf8'); } finally { bytes.fill(0); }
}

export function ensurePrivateDataDirectory(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    if (process.platform !== 'win32') return;
    const script = String.raw`
      $ErrorActionPreference = 'Stop'
      $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $existing = [IO.Directory]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Owner)
      if ($existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Unexpected owner' }
      $acl = [Security.AccessControl.DirectorySecurity]::new()
      $acl.SetAccessRuleProtection($true, $false)
      $access = [Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($access)
      [IO.Directory]::SetAccessControl($path, $acl)
    `;
    execFileSync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: `${Buffer.from(directory, 'utf8').toString('base64')}\n`,
      env: windowsPowerShellEnv(), windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { throw new Error('data_directory_not_private'); }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsPowerShell, windowsPowerShellEnv } from './windows-powershell.js';

const run = promisify(execFile);

export async function installedVersion(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-AppxPackage -Name OpenAI.Codex).Version.ToString()'], {
      encoding: 'utf8', env: windowsPowerShellEnv(), timeout: 5000, windowsHide: true,
    });
    const version = stdout.trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch { return null; }
}

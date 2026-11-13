import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings.js';
import { windowsPowerShell, windowsPowerShellEnv } from './windows-powershell.js';

export async function runWindowsSetup(): Promise<void> {
  const shell = windowsPowerShell();
  readSettings(); // Reject an invalid config before opening the editor.
  const script = fileURLToPath(new URL('../../../scripts/setup-window.ps1', import.meta.url));
  const worker = fileURLToPath(new URL('./setup-worker.js', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    // A hidden startup on Windows also suppresses the WinForms dialog's first show.
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
      '-File', script, '-NodeExecutable', process.execPath, '-Worker', worker],
      { env: windowsPowerShellEnv(), windowsHide: false, stdio: 'ignore' });
    child.once('error', () => reject(new Error('setup_window_failed')));
    child.once('exit', code => code === 0 || code === 2 ? resolve() : reject(new Error('setup_window_failed')));
  });
}

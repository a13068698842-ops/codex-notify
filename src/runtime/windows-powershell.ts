import { dirname, isAbsolute, join } from 'node:path';

export function windowsPowerShell(): string {
  if (process.platform !== 'win32' || !process.env.SystemRoot || !isAbsolute(process.env.SystemRoot))
    throw new Error('windows_required');
  return join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function windowsPowerShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  // Windows PowerShell must not auto-load PowerShell 7 binaries inherited from its caller.
  env.PSModulePath = join(dirname(windowsPowerShell()), 'Modules');
  return env;
}

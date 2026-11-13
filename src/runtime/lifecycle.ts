import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireWindowsPipe, releaseServer, scopeId } from './locks.js';
import { dataDirectory } from './settings.js';
import { windowsPowerShell, windowsPowerShellEnv } from './windows-powershell.js';
import { ensurePrivateDataDirectory } from './windows-storage.js';

export type RuntimeDetails = {
  desktop: 'waiting' | 'ready' | 'incompatible';
  feishu: 'waiting' | 'ready' | 'connection-error' | 'reconnecting';
  registered: number;
  connected: number;
  failed: number;
  unknown: number;
  code?: string;
};
export type RuntimeStatus = {
  state: 'stopped' | 'starting' | 'running' | 'stopping';
  pid?: number;
  details?: RuntimeDetails;
  code?: string;
};
type RegistrationCommand = 'register' | 'unwatch';
type ControlInfo = { version: 1; pipe: string; token: string; pid: number };
type ControlRequest = { command: 'status' | 'stop' } |
  { command: RegistrationCommand; registration: unknown };
type ControlResponse = { ok: true; status?: RuntimeStatus } |
  { ok: false; code: 'runtime_stopping' | 'registration_rejected' };

const tokenFormat = /^[0-9a-f]{64}$/;
const safeCode = /^[a-z][a-z0-9_]{0,63}$/;
const maxRequestBytes = 64 * 1024;
const controlTimeout = 2000;
const launchFailures = new Set(['background_failed', 'data_directory_not_private', 'runtime_disabled_or_unconfigured',
  'config_unreadable_or_invalid', 'question_rules_invalid']);

function runtimeScope(): string {
  return scopeId(resolve(dataDirectory()).toLowerCase());
}
function controlPipe(): string {
  return '\\\\.\\pipe\\codex-notify-control-' + runtimeScope();
}
function controlFile(): string {
  return join(dataDirectory(), 'control.json');
}
function exitFile(): string {
  return join(dataDirectory(), 'runtime-exit.json');
}

function writeAtomic(file: string, value: unknown): void {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function controlInfo(): ControlInfo | undefined {
  let value: ControlInfo;
  try { value = JSON.parse(readFileSync(controlFile(), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('runtime_control_unreadable');
  }
  if (value?.version !== 1 || value.pipe !== controlPipe() || typeof value.token !== 'string' ||
      !tokenFormat.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid < 1)
    throw new Error('runtime_control_unreadable');
  return value;
}

export function acquireRuntimeControlLock(listener?: (socket: Socket) => void): Promise<Server> {
  return acquireWindowsPipe(controlPipe(), 'runtime_busy', listener);
}

function respond(socket: Socket, response: ControlResponse): void {
  socket.end(JSON.stringify(response) + '\n');
}

/** Hold the process lock until the application has drained submissions and closed both connections. */
export async function runDaemon(run: (signal: AbortSignal, update: (details: RuntimeDetails) => void) => Promise<void>,
  register?: (command: RegistrationCommand, registration: unknown) => void): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token, 'hex');
  let details: RuntimeDetails | undefined;
  let active = false;
  const status = (): RuntimeStatus => ({
    state: shutdown.signal.aborted ? 'stopping' : details ? 'running' : 'starting',
    pid: process.pid,
    ...(details && { details }),
  });

  const server = await acquireRuntimeControlLock(socket => {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(controlTimeout, () => socket.destroy());
    let input = Buffer.alloc(0);
    socket.on('end', () => { if (!input.includes(10)) socket.destroy(); });
    socket.on('data', (chunk: Buffer) => {
      if (input.length + chunk.length > maxRequestBytes) { socket.destroy(); return; }
      input = Buffer.concat([input, chunk]);
      const newline = input.indexOf(10);
      if (newline < 0) return;
      socket.removeAllListeners('data');
      if (newline !== input.length - 1 || !active) { socket.destroy(); return; }
      let request;
      try { request = JSON.parse(input.toString('utf8', 0, newline)); }
      catch { socket.destroy(); return; }
      if (typeof request?.token !== 'string' || !tokenFormat.test(request.token) ||
          !timingSafeEqual(Buffer.from(request.token, 'hex'), tokenBytes)) { socket.destroy(); return; }

      if (request.command === 'stop') {
        stop();
        respond(socket, { ok: true, status: status() });
      } else if (request.command === 'status') {
        respond(socket, { ok: true, status: status() });
      } else if (request.command === 'register' || request.command === 'unwatch') {
        if (shutdown.signal.aborted) { respond(socket, { ok: false, code: 'runtime_stopping' }); return; }
        try {
          if (!register) throw new Error('registration_not_available');
          register(request.command, request.registration);
          respond(socket, { ok: true });
        } catch {
          respond(socket, { ok: false, code: 'registration_rejected' });
        }
      } else socket.destroy();
    });
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    ensurePrivateDataDirectory(dataDirectory());
    rmSync(exitFile(), { force: true });
    writeAtomic(controlFile(), { version: 1, pipe: controlPipe(), token, pid: process.pid } satisfies ControlInfo);
    active = true;
    await run(shutdown.signal, next => {
      const { desktop, feishu, registered, connected, failed, unknown, code } = next;
      details = { desktop, feishu, registered, connected, failed, unknown, ...(code && safeCode.test(code) && { code }) };
    });
  } catch (error) {
    const code = error instanceof Error && launchFailures.has(error.message) ? error.message : 'background_failed';
    try { writeAtomic(exitFile(), { code }); } catch { /* No writable diagnostics location. */ }
    throw error;
  } finally {
    active = false;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { rmSync(controlFile(), { force: true }); } finally { await releaseServer(server); }
  }
}

function requestControl(request: ControlRequest, info = controlInfo()): Promise<ControlResponse | undefined> {
  if (!info) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const socket = createConnection(info.pipe);
    const finish = (value?: ControlResponse) => { resolve(value); socket.destroy(); };
    const failed = (code: string) => { reject(new Error(code)); socket.destroy(); };
    socket.setEncoding('utf8');
    // Credential and proxy loading can occupy the worker briefly before it
    // can accept the stop request. Give shutdown a longer control deadline.
    socket.setTimeout(request.command === 'stop' ? 15_000 : controlTimeout, () => failed('runtime_control_timeout'));
    socket.once('connect', () => socket.end(JSON.stringify({ ...request, token: info.token }) + '\n'));
    socket.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes((error as NodeJS.ErrnoException).code ?? ''))
        finish();
      else failed('runtime_control_unavailable');
    });
    socket.once('end', () => finish());
    socket.once('close', () => resolve(undefined));
    let input = '';
    socket.on('data', (part: string) => {
      input += part;
      if (input.length > maxRequestBytes) { failed('runtime_control_invalid'); return; }
      if (!input.endsWith('\n')) return;
      try {
        const value = JSON.parse(input) as ControlResponse;
        if (typeof value?.ok !== 'boolean') { failed('runtime_control_invalid'); return; }
        finish(value);
      } catch { failed('runtime_control_invalid'); }
    });
  });
}

function stoppedStatus(): RuntimeStatus {
  try {
    const { code } = JSON.parse(readFileSync(exitFile(), 'utf8'));
    if (typeof code === 'string' && launchFailures.has(code)) return { state: 'stopped', code };
  } catch { /* No recorded daemon error. */ }
  return { state: 'stopped' };
}

export async function backgroundStatus(): Promise<RuntimeStatus> {
  const result = await requestControl({ command: 'status' });
  return (result?.ok && result.status) || stoppedStatus();
}

export async function updateBackgroundRegistration(command: RegistrationCommand, registration: unknown): Promise<boolean> {
  const result = await requestControl({ command, registration });
  if (!result || (!result.ok && result.code === 'runtime_stopping')) return false;
  if (!result.ok) throw new Error('registration_rejected');
  return true;
}

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

export async function startBackground(script = cliPath): Promise<RuntimeStatus> {
  if (process.platform !== 'win32') throw new Error('windows_required');
  const current = await backgroundStatus();
  if (current.state !== 'stopped') return current;
  const child = spawn(process.execPath, [script, 'daemon'], {
    cwd: dirname(script), detached: true, windowsHide: true, stdio: 'ignore',
  });
  let exited = false;
  let spawned = true;
  child.once('error', () => { spawned = false; });
  child.once('exit', () => { exited = true; });
  child.unref();

  const deadline = Date.now() + 15_000;
  let exitedAt: number | undefined;
  do {
    if (!spawned) throw new Error('background_launch_failed');
    const next = await backgroundStatus();
    if (next.state !== 'stopped') return next;
    if (exited) {
      // Another start may have won the pipe and still be publishing its token.
      exitedAt ??= Date.now();
      if (Date.now() - exitedAt >= 1500) throw new Error(next.code ?? 'runtime_busy');
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('background_start_timed_out');
}

function processExists(pid: number): boolean {
  try { return process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('background_exit_unconfirmed');
  }
}

export async function stopBackground(): Promise<RuntimeStatus> {
  const result = await requestControl({ command: 'stop' });
  const pid = result?.ok ? result.status?.pid : undefined;
  if (!pid) return stoppedStatus();
  const deadline = Date.now() + 55_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error('background_stop_timed_out');
    await delay(100);
  }
  return stoppedStatus();
}

/** Logon is scoped to the current interactive Windows user and never elevates. */
export function setLoginStartup(enabled: boolean): void {
  if (process.platform !== 'win32') throw new Error('windows_required');
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $task = $env:CODEX_NOTIFY_SCHEDULER_TASK
    if ($env:CODEX_NOTIFY_SCHEDULER_ENABLED -ne '1') {
      if (Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $task) {
        Unregister-ScheduledTask -TaskName $task -TaskPath '\' -Confirm:$false
      }
      exit
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $arguments = [char]34 + $env:CODEX_NOTIFY_SCHEDULER_CLI + [char]34 + ' start --login'
    $action = New-ScheduledTaskAction -Execute $env:CODEX_NOTIFY_SCHEDULER_NODE -Argument $arguments -WorkingDirectory $env:CODEX_NOTIFY_SCHEDULER_CWD
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $task -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  `;
  // Setup runs in setup-worker.js; the scheduled action must always invoke the
  // installed CLI, regardless of which process is updating the login setting.
  const cli = cliPath;
  try {
    const powerShell = windowsPowerShell();
    execFileSync(powerShell,
      ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...windowsPowerShellEnv(),
          CODEX_NOTIFY_SCHEDULER_TASK: 'CodexNotify-' + runtimeScope(),
          CODEX_NOTIFY_SCHEDULER_ENABLED: enabled ? '1' : '0', CODEX_NOTIFY_SCHEDULER_NODE: process.execPath,
          CODEX_NOTIFY_SCHEDULER_CLI: cli, CODEX_NOTIFY_SCHEDULER_CWD: dirname(cli) },
        windowsHide: true, timeout: 12_000, stdio: 'ignore',
      });
  } catch { throw new Error('login_startup_update_failed'); }
}

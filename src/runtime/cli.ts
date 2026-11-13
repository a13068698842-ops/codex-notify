import { existsSync } from 'node:fs';
import { DesktopAdapter } from '../desktop/adapter.js';
import { threadIdFrom } from '../desktop/protocol.js';
import { localTranscriptPath } from '../desktop/transcript.js';
import { installedVersion } from './desktop-version.js';
import { backgroundStatus, setLoginStartup, startBackground, stopBackground, updateBackgroundRegistration } from './lifecycle.js';
import { registerLocal } from './registrations.js';
import { readSettings, updateRunSettings } from './settings.js';

const usage = 'Usage: codex-notify init|start|stop|status|doctor|watch <chat UUID or codex://threads/...>|unwatch <chat UUID>|disable';

function print(data: unknown) { console.log(JSON.stringify(data)); }

async function watch(thread: string) {
  const adapter = new DesktopAdapter(thread);
  try {
    const state = await adapter.connect();
    const registration = { threadId: adapter.threadId, cwd: state.cwd,
      transcriptPath: localTranscriptPath(state.rolloutPath, adapter.threadId) ? state.rolloutPath : null };
    const background = await updateBackgroundRegistration('register', { ...registration, source: 'manual' });
    // The repository's standalone protocol check predates the installed runtime.
    // Its registrations are deliberately not imported into the installed service.
    if (!background) {
      if (readSettings() || existsSync(new URL('../../../codex-notify-release.json', import.meta.url)))
        throw new Error('runtime_not_running');
      registerLocal(registration);
    }
    print({ threadId: adapter.threadId, ownerFound: Boolean(adapter.owner), revision: adapter.revision,
      state: adapter.health, registered: true, background, pendingRequests: state.requests.length,
      turnHistoryKind: state.turnHistory?.kind ?? 'legacy' });
  } finally { await adapter.close().catch(() => {}); }
}

async function foreground(command: 'native-live' | 'plain-live', thread: string) {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const { runForegroundLive } = await import('./foreground-live.js');
    await runForegroundLive(command === 'native-live' ? 'native' : 'plain', thread, await installedVersion(), shutdown.signal);
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function main([command, ...args]: string[]) {
  if (!command || ['-h', '--help', 'help'].includes(command)) { console.log(usage); return; }
  if (command === 'watch' && args.length === 1) return watch(args[0]);
  if (command === 'unwatch' && args.length === 1) {
    const threadId = threadIdFrom(args[0]);
    if (!await updateBackgroundRegistration('unwatch', { threadId })) throw new Error('runtime_not_running');
    print({ threadId, registered: false });
    return;
  }
  if ((command === 'native-live' || command === 'plain-live') && args.length === 1) return foreground(command, args[0]);
  if (command === 'start' && (args.length === 0 || (args.length === 1 && args[0] === '--login'))) {
    const settings = readSettings();
    if (args[0] === '--login' && (!settings?.enabled || !settings.autoStart)) return;
    if (!settings) throw new Error('config_missing_run_init');
    if (!settings.enabled) {
      if (settings.autoStart) setLoginStartup(true);
      updateRunSettings({ enabled: true });
    }
    print(await startBackground());
    return;
  }
  if (!args.length) switch (command) {
    case 'init': {
      const { runWindowsSetup } = await import('./setup.js');
      await runWindowsSetup();
      return;
    }
    case 'status': {
      const settings = readSettings();
      print({ ...await backgroundStatus(), configured: !!settings, enabled: settings?.enabled ?? false,
        autoStart: settings?.autoStart ?? false });
      return;
    }
    case 'doctor': {
      const { doctor } = await import('./doctor.js');
      print(await doctor());
      return;
    }
    case 'stop': print(await stopBackground()); return;
    case 'disable': {
      try {
        if (readSettings()) updateRunSettings({ enabled: false, autoStart: false });
      } finally {
        try { setLoginStartup(false); }
        finally { print(await stopBackground()); }
      }
      return;
    }
    case 'daemon': {
      const { runInstalledDaemon } = await import('./service.js');
      await runInstalledDaemon();
      return;
    }
  }
  console.error(usage);
  process.exitCode = 2;
}

try { await main(process.argv.slice(2)); }
catch (error) {
  const reason = error instanceof Error ? error.message : '';
  const code = reason === 'incompatible' ? 'desktop_protocol_incompatible' :
    /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason :
    reason.startsWith('Expected a local desktop thread UUID') ? 'invalid_chat_id' :
    reason === 'No live local desktop owner.' ? 'desktop_owner_unavailable' : 'command_failed';
  console.error(JSON.stringify({ event: 'command_failed', code }));
  process.exitCode = 1;
}

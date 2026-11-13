import type { Server } from 'node:net';
import { createInterface } from 'node:readline';
import { object } from '../feishu/cards.js';
import type { FeishuConfig } from '../feishu/transport.js';
import { resolveStoredFeishuProxy, validateFeishuDestination, validateFeishuSecret, validateStoredProxy } from './feishu-config.js';
import { registerFeishuBot } from './feishu-registration.js';
import { acquireRuntimeControlLock, setLoginStartup, startBackground } from './lifecycle.js';
import { acquireFeishuAppLock, releaseServer } from './locks.js';
import { readInstalledFeishuConfig, readSettings, saveVerifiedSettings } from './settings.js';
import { verifyFeishuTestCard } from './setup-test.js';

function emit(code: string): void { process.stdout.write(`${code}\n`); }

const knownCodes = new Set(['feishu_credentials_missing_or_invalid', 'feishu_target_missing_or_invalid',
  'feishu_operators_missing_or_invalid', 'windows_proxy_unreadable', 'unsupported_proxy',
  'windows_pac_requires_explicit_proxy', 'proxy_credentials_in_config', 'feishu_setup_connection_failed',
  'feishu_setup_card_rejected', 'feishu_setup_card_send_unconfirmed', 'feishu_setup_click_timeout',
  'credential_protection_failed', 'credential_unreadable_or_invalid', 'data_directory_not_private',
  'config_unreadable_or_invalid', 'config_write_failed', 'feishu_app_busy', 'setup_runtime_busy', 'setup_input_invalid',
  'feishu_registration_failed', 'feishu_registration_denied', 'feishu_registration_expired',
  'feishu_registration_missing_identity', 'feishu_registration_unsupported_brand']);
const retryableCardErrors = new Set(['feishu_setup_connection_failed', 'feishu_setup_card_rejected',
  'feishu_setup_card_send_unconfirmed', 'feishu_setup_click_timeout']);

async function formInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes);
      size += bytes.length;
      if (size > 32 * 1024) throw new Error('setup_input_invalid');
    }
    const bytes = Buffer.concat(chunks);
    try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
    finally { bytes.fill(0); }
  }
  catch { throw new Error('setup_input_invalid'); }
  finally { for (const bytes of chunks) bytes.fill(0); }
}

async function manualConfig(): Promise<{ config: FeishuConfig; storedProxy: string; autoStart: boolean }> {
  const raw = await formInput();
  if (!object(raw) || typeof raw.appId !== 'string' || typeof raw.appSecret !== 'string' ||
      (raw.targetType !== 'open_id' && raw.targetType !== 'chat_id') || typeof raw.targetId !== 'string' ||
      typeof raw.operators !== 'string' || typeof raw.proxy !== 'string' || typeof raw.autoStart !== 'boolean')
    throw new Error('setup_input_invalid');
  const destination = validateFeishuDestination({ appId: raw.appId, targetType: raw.targetType, targetId: raw.targetId,
    allowedOperatorIds: raw.operators.trim() ? raw.operators.split(',') : raw.targetType === 'open_id' ? [raw.targetId] : [] });
  const storedProxy = validateStoredProxy(raw.proxy);
  const previous = readSettings();
  const appSecret = validateFeishuSecret(raw.appSecret || (previous?.channel.appId === destination.appId
    ? readInstalledFeishuConfig({ ...previous, proxy: 'direct' }).appSecret : ''));
  const config = { ...destination, appSecret, proxy: resolveStoredFeishuProxy(storedProxy) };
  return { config, storedProxy, autoStart: raw.autoStart };
}

function parseQROptions(line: string | undefined): { storedProxy: string; autoStart: boolean } {
  let raw: unknown;
  try { if (line && line.length <= 2048) raw = JSON.parse(line); } catch { /* Rejected below. */ }
  if (!object(raw) || typeof raw.proxy !== 'string' || typeof raw.autoStart !== 'boolean')
    throw new Error('setup_input_invalid');
  return { storedProxy: validateStoredProxy(raw.proxy), autoStart: raw.autoStart };
}

let runtimeLock: Server | undefined;
let appLock: Server | undefined;
let input: ReturnType<typeof createInterface> | undefined;
try {
  try { runtimeLock = await acquireRuntimeControlLock(); } catch { throw new Error('setup_runtime_busy'); }
  let config: FeishuConfig;
  let storedProxy: string;
  let autoStart: boolean;
  const scan = process.argv[2] === '--scan';
  let lines: AsyncIterator<string> | undefined;
  if (scan) {
    // QR onboarding only creates a new connection. Editing an existing setup uses the manual path.
    if (readSettings()) throw new Error('setup_input_invalid');
    input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines = input[Symbol.asyncIterator]();
    ({ storedProxy, autoStart } = parseQROptions((await lines.next()).value));
    const proxy = resolveStoredFeishuProxy(storedProxy);
    config = await registerFeishuBot(proxy, gif => emit(JSON.stringify({ qr: gif })));
    emit('bot_created');
  } else {
    ({ config, storedProxy, autoStart } = await manualConfig());
  }
  appLock = await acquireFeishuAppLock(config.appId);
  for (;;) {
    emit('connecting');
    try {
      await verifyFeishuTestCard(config, () => emit('card_sent'));
      break;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!lines || !retryableCardErrors.has(code)) throw error;
      emit(code);
      emit('retry_card');
      // Retain the just-created bot's credentials only in memory. Retry with a new
      // card and callback token, without making the user create another bot.
      if ((await lines.next()).value !== 'retry') throw error;
    }
  }
  emit('saving');
  const settings = saveVerifiedSettings(config, storedProxy, autoStart);
  let loginFailed = false;
  try { setLoginStartup(settings.enabled && settings.autoStart); } catch { loginFailed = true; }
  if (scan) {
    await releaseServer(appLock);
    appLock = undefined;
    await releaseServer(runtimeLock);
    runtimeLock = undefined;
    try {
      await startBackground();
      emit(loginFailed ? 'scan_done_login_failed' : 'scan_done');
    } catch { emit('scan_saved_start_failed'); }
  } else {
    emit(loginFailed ? 'saved_autostart_failed' : settings.enabled ? 'saved' : 'saved_paused');
  }
} catch (error) {
  const value = error instanceof Error ? error.message : '';
  emit(knownCodes.has(value) ? value : 'setup_failed');
  process.exitCode = 1;
} finally {
  input?.close();
  if (input) process.stdin.pause();
  if (appLock) await releaseServer(appLock);
  if (runtimeLock) await releaseServer(runtimeLock);
}

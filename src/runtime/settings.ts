import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { object } from '../feishu/cards.js';
import type { FeishuConfig } from '../feishu/transport.js';
import { resolveStoredFeishuProxy, validateFeishuDestination, validateFeishuSecret, validateStoredProxy,
  type FeishuDestination } from './feishu-config.js';
import { ensurePrivateDataDirectory, protectCredential, unprotectCredential } from './windows-storage.js';

export type Settings = {
  version: 1;
  enabled: boolean;
  channel: FeishuDestination & { type: 'feishu'; credentialRef: string };
  proxy: string;
  questionRulesPath: string | null;
  receiptTimeoutMs: number;
  logLevel: 'info';
  autoStart: boolean;
};

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) throw new Error('localappdata_required');
  return join(env.LOCALAPPDATA, 'CodexNotify');
}

const refPattern = /^secret-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.dpapi$/;
function code(error: unknown): unknown { return (error as NodeJS.ErrnoException | null)?.code; }

function decodeSettings(raw: unknown): Settings {
  if (!object(raw) || raw.version !== 1 || typeof raw.enabled !== 'boolean' || typeof raw.autoStart !== 'boolean' ||
      typeof raw.proxy !== 'string' || raw.logLevel !== 'info' ||
      (raw.questionRulesPath !== null && (typeof raw.questionRulesPath !== 'string' || !isAbsolute(raw.questionRulesPath))) ||
      typeof raw.receiptTimeoutMs !== 'number' || !Number.isSafeInteger(raw.receiptTimeoutMs) ||
      raw.receiptTimeoutMs < 1000 || raw.receiptTimeoutMs > 300_000 || !object(raw.channel)) throw new Error();
  const { type, credentialRef, appId, targetId, targetType, allowedOperatorIds } = raw.channel;
  if (type !== 'feishu' || typeof credentialRef !== 'string' || !refPattern.test(credentialRef) ||
      typeof appId !== 'string' || typeof targetId !== 'string' || (targetType !== 'open_id' && targetType !== 'chat_id') ||
      !Array.isArray(allowedOperatorIds) || !allowedOperatorIds.every(id => typeof id === 'string')) throw new Error();
  return { version: 1, enabled: raw.enabled, autoStart: raw.autoStart, proxy: validateStoredProxy(raw.proxy),
    questionRulesPath: raw.questionRulesPath, receiptTimeoutMs: raw.receiptTimeoutMs, logLevel: 'info',
    channel: { type, credentialRef, ...validateFeishuDestination({ appId, targetType, targetId, allowedOperatorIds }) } };
}

export function readSettings(dir = dataDirectory()): Settings | null {
  try {
    const value = readFileSync(join(dir, 'config.json'), 'utf8');
    if (value.length > 64 * 1024) throw new Error();
    return decodeSettings(JSON.parse(value));
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw new Error('config_unreadable_or_invalid');
  }
}

export function readInstalledFeishuConfig(settings: Settings, dir = dataDirectory(), env = process.env): FeishuConfig {
  const { credentialRef, type: _type, ...destination } = settings.channel;
  const proxy = resolveStoredFeishuProxy(settings.proxy, env);
  try {
    if (!refPattern.test(credentialRef)) throw new Error();
    const ciphertext = readFileSync(join(dir, credentialRef));
    if (ciphertext.length < 1 || ciphertext.length > 32 * 1024) throw new Error();
    return { ...destination, appSecret: validateFeishuSecret(unprotectCredential(ciphertext)), proxy };
  } catch { throw new Error('credential_unreadable_or_invalid'); }
}

function writeSettings(settings: Settings, dir: string): void {
  const temp = join(dir, `config.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(decodeSettings(settings), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, join(dir, 'config.json'));
  } finally { try { rmSync(temp, { force: true }); } catch { /* Preserve the original failure. */ } }
}

export function updateRunSettings(patch: Partial<Pick<Settings, 'enabled' | 'autoStart'>>, dir = dataDirectory()): Settings {
  const settings = readSettings(dir);
  if (!settings) throw new Error('config_missing');
  if (patch.enabled !== undefined) settings.enabled = patch.enabled;
  if (patch.autoStart !== undefined) settings.autoStart = patch.autoStart;
  try { writeSettings(settings, dir); } catch { throw new Error('config_write_failed'); }
  return settings;
}

/** Caller holds the runtime lock, so a running service cannot read a stale credential reference. */
export function saveVerifiedSettings(config: FeishuConfig, proxy: string, autoStart: boolean, dir = dataDirectory()): Settings {
  const { appId, appSecret, targetId, targetType, allowedOperatorIds } = config;
  const destination = validateFeishuDestination({ appId, targetId, targetType, allowedOperatorIds });
  const storedProxy = validateStoredProxy(proxy);
  const previous = readSettings(dir);
  const credentialRef = `secret-${randomUUID()}.dpapi`;
  const settings: Settings = { version: 1, enabled: previous?.enabled ?? true, proxy: storedProxy,
    questionRulesPath: previous?.questionRulesPath ?? null, receiptTimeoutMs: previous?.receiptTimeoutMs ?? 60_000,
    logLevel: 'info', autoStart, channel: { ...destination, type: 'feishu', credentialRef } };
  ensurePrivateDataDirectory(dir);
  const ciphertext = protectCredential(validateFeishuSecret(appSecret));
  const blob = join(dir, credentialRef);
  try {
    writeFileSync(blob, ciphertext, { flag: 'wx', mode: 0o600 });
    writeSettings(settings, dir);
  } catch {
    try { rmSync(blob, { force: true }); } catch { /* The old settings and credential stay usable. */ }
    throw new Error('config_write_failed');
  }
  if (previous) {
    try { rmSync(join(dir, previous.channel.credentialRef), { force: true }); } catch { /* Only an encrypted blob remains. */ }
  }
  return settings;
}

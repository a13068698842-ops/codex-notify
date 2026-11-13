import { execFileSync } from 'node:child_process';
import type { FeishuConfig } from '../feishu/transport.js';
import { windowsPowerShell, windowsPowerShellEnv } from './windows-powershell.js';

type WindowsProxy = { enabled: boolean; manual: string | null; pac: boolean; bypass?: string };

function configError(code: string): never { throw new Error(code); }

export function readWindowsProxy(): WindowsProxy {
  if (process.platform !== 'win32') return { enabled: false, manual: null, pac: false };
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $p = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    [pscustomobject]@{ enabled = ($p.ProxyEnable -eq 1); manual = $p.ProxyServer; bypass = $p.ProxyOverride;
      pac = [bool]$p.AutoConfigURL } | ConvertTo-Json -Compress
  `;
  try {
    return JSON.parse(execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', env: windowsPowerShellEnv(), timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { return configError('windows_proxy_unreadable'); }
}

function proxyUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return configError('unsupported_proxy'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.pathname !== '/' || url.search || url.hash) return configError('unsupported_proxy');
  return url;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || env[name.toLowerCase()]?.trim() || undefined;
}

function bypassFeishu(noProxy: string | undefined): boolean {
  const host = 'open.feishu.cn';
  return noProxy?.toLowerCase().split(/[\s,]+/).some(rule => {
    if (rule === '*') return true;
    const [domain, port] = rule.split(':');
    if (port && port !== '443') return false;
    const suffix = domain.replace(/^\*?\./, '');
    return !!suffix && (host === suffix || host.endsWith(`.${suffix}`));
  }) ?? false;
}

export function resolveFeishuProxy(env: NodeJS.ProcessEnv, windows = readWindowsProxy): URL | null {
  const explicit = envValue(env, 'CODEX_NOTIFY_FEISHU_PROXY');
  if (explicit) return explicit.toLowerCase() === 'direct' ? null : proxyUrl(explicit);
  if (bypassFeishu(envValue(env, 'NO_PROXY'))) return null;
  const fromEnv = envValue(env, 'HTTPS_PROXY') ?? envValue(env, 'HTTP_PROXY') ?? envValue(env, 'ALL_PROXY');
  if (fromEnv) return proxyUrl(fromEnv);
  const settings = windows();
  if (settings.pac) return configError('windows_pac_requires_explicit_proxy');
  if (!settings.enabled) return null;
  if (settings.bypass?.toLowerCase().split(';').map(rule => rule.trim()).filter(Boolean).some(rule =>
    new RegExp(`^${rule.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      .test('open.feishu.cn'))) return null;
  if (!settings.manual) return configError('windows_proxy_unreadable');
  const manual = settings.manual.trim();
  const entries = manual.split(';').map(part => part.trim());
  const address = manual.includes('=')
    ? entries.find(part => /^https=/i.test(part))?.slice(6)
    : entries.length === 1 ? entries[0] : undefined;
  if (!address) return configError('unsupported_proxy');
  return proxyUrl(address.includes('://') ? address : `http://${address}`);
}

export function validateStoredProxy(raw: string): string {
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'auto') return 'auto';
  if (value.toLowerCase() === 'direct') return 'direct';
  const url = proxyUrl(value);
  if (url.username || url.password) return configError('proxy_credentials_in_config');
  return url.href;
}

export function resolveStoredFeishuProxy(setting: string, env: NodeJS.ProcessEnv = process.env): URL | null {
  const value = validateStoredProxy(setting);
  return value === 'auto' ? resolveFeishuProxy(env) : value === 'direct' ? null : proxyUrl(value);
}

export type FeishuDestination = Pick<FeishuConfig, 'appId' | 'targetType' | 'targetId' | 'allowedOperatorIds'>;

export function validateFeishuDestination(raw: FeishuDestination): FeishuDestination {
  const appId = raw.appId.trim();
  const targetId = raw.targetId.trim();
  const targetType = raw.targetType;
  if (!/^cli_[0-9a-f]{16}$/i.test(appId))
    return configError('feishu_credentials_missing_or_invalid');
  if (!((targetType === 'open_id' && /^ou_[a-z0-9]{1,128}$/i.test(targetId)) ||
      (targetType === 'chat_id' && /^oc_[a-z0-9]{1,128}$/i.test(targetId))))
    return configError('feishu_target_missing_or_invalid');
  const allowedOperatorIds = [...new Set(raw.allowedOperatorIds.map(id => id.trim()).filter(Boolean))];
  if (!allowedOperatorIds.length || allowedOperatorIds.some(id => !/^ou_[a-z0-9]{1,128}$/i.test(id)))
    return configError('feishu_operators_missing_or_invalid');
  return { appId, targetType, targetId, allowedOperatorIds };
}

export function validateFeishuSecret(appSecret: string): string {
  if (!appSecret.trim() || appSecret.length > 4096) return configError('feishu_credentials_missing_or_invalid');
  return appSecret;
}

export function readFeishuConfig(env: NodeJS.ProcessEnv = process.env): FeishuConfig {
  const appId = env.FEISHU_APP_ID?.trim() ?? '';
  const appSecret = validateFeishuSecret(env.FEISHU_APP_SECRET ?? '');
  const openId = env.FEISHU_OPEN_ID?.trim();
  const chatId = env.FEISHU_CHAT_ID?.trim();
  if (!!openId === !!chatId) return configError('feishu_target_missing_or_invalid');
  const operators = env.FEISHU_ALLOWED_OPERATOR_IDS;
  const destination = validateFeishuDestination({ appId, targetType: chatId ? 'chat_id' : 'open_id',
    targetId: (chatId || openId)!, allowedOperatorIds: operators === undefined ? (openId ? [openId] : []) : operators.split(',') });
  return { ...destination, appSecret, proxy: resolveFeishuProxy(env) };
}

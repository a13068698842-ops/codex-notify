import { mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { probeFeishuAuth } from '../feishu/transport.js';
import { loadQuestionRules } from '../questions/plain.js';
import { CodexDesktopIpcClient } from '../vendor/codex-mobile/codex/CodexDesktopIpcClient.js';
import { installedVersion } from './desktop-version.js';
import { backgroundStatus } from './lifecycle.js';
import { dataDirectory, readInstalledFeishuConfig, readSettings } from './settings.js';
import { ensurePrivateDataDirectory } from './windows-storage.js';

export async function doctor() {
  const dir = dataDirectory();
  let dataWritable = false;
  try {
    ensurePrivateDataDirectory(dir);
    const probe = mkdtempSync(join(dir, 'doctor-'));
    rmdirSync(probe);
    dataWritable = true;
  } catch { /* The path and system error might disclose user details. */ }
  const [version, runtime] = await Promise.all([installedVersion(), backgroundStatus()]);
  let desktopIpc = false;
  const ipc = new CodexDesktopIpcClient({ debug() {}, info() {}, warn() {} });
  try { await ipc.start(); desktopIpc = ipc.isReady(); }
  catch { /* Desktop may be closed. */ }
  finally { await ipc.stop(); }
  const settings = readSettings(dir);
  let rules = false;
  try { loadQuestionRules(settings?.questionRulesPath ?? undefined); rules = true; }
  catch { /* Report only the failed check. */ }
  const base = { node: process.version, desktopVersion: version, desktopIpc, dataWritable, questionRules: rules, runtime };
  if (!settings) return { ...base, configured: false, feishuAuth: 'not_checked' as const };
  const config = readInstalledFeishuConfig(settings, dir);
  return { ...base, configured: true, proxy: config.proxy ? 'http_proxy' : 'direct',
    feishuAuth: await probeFeishuAuth(config) ? 'ok' as const : 'failed' as const };
}

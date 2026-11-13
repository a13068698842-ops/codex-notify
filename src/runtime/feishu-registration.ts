import { Agent } from 'node:https';
import { defaultHttpInstance, registerApp } from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import qrcode from 'qrcode-generator';
import type { FeishuConfig } from '../feishu/transport.js';
import { validateFeishuDestination, validateFeishuSecret } from './feishu-config.js';

/** Only used in the dedicated setup worker. The SDK registration API uses its
 * shared HTTP instance and does not accept a per-call transport. */
export async function registerFeishuBot(proxy: URL | null, onQRCode: (gif: string) => void): Promise<FeishuConfig> {
  const agent = proxy ? new HttpsProxyAgent(proxy) : new Agent();
  const cancel = new AbortController();
  let unsupportedBrand = false;
  const interceptor = defaultHttpInstance.interceptors.request.use(request => {
    if (request.url !== 'https://accounts.feishu.cn/oauth/v1/app/registration')
      throw new Error('feishu_registration_unexpected_endpoint');
    return { ...request, httpsAgent: agent, proxy: false, maxRedirects: 0, timeout: 15_000,
      maxContentLength: 32 * 1024, signal: cancel.signal };
  });
  try {
    const result = await registerApp({
      source: 'codex-notify',
      signal: cancel.signal,
      createOnly: true,
      appPreset: { name: 'Codex Notify', desc: '接收 Codex 问题并把你的回答送回原聊天。' },
      addons: {
        preset: false,
        scopes: { tenant: ['im:message:send_as_bot'] },
        callbacks: { items: ['card.action.trigger'] },
      },
      onQRCodeReady({ url }) {
        if (new URL(url).origin !== 'https://open.feishu.cn' || url.length > 2048)
          throw new Error('feishu_registration_unexpected_url');
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        // GIF and quiet zone are rendered locally. The URL is never sent to a QR service.
        const scale = Math.min(5, Math.floor(340 / (qr.getModuleCount() + 8)));
        onQRCode(qr.createDataURL(scale, 4 * scale).slice('data:image/gif;base64,'.length));
      },
      onStatusChange({ status }) {
        if (status !== 'domain_switched') return;
        unsupportedBrand = true;
        cancel.abort();
      },
    });
    const openId = result.user_info?.open_id;
    if (!openId) throw new Error('feishu_registration_missing_identity');
    const destination = validateFeishuDestination({
      appId: result.client_id, targetType: 'open_id', targetId: openId, allowedOperatorIds: [openId],
    });
    return { ...destination, appSecret: validateFeishuSecret(result.client_secret), proxy };
  } catch (error) {
    if (unsupportedBrand) throw new Error('feishu_registration_unsupported_brand');
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'access_denied') throw new Error('feishu_registration_denied');
    if (code === 'expired_token') throw new Error('feishu_registration_expired');
    if (error instanceof Error && error.message === 'feishu_registration_missing_identity') throw error;
    throw new Error('feishu_registration_failed');
  } finally {
    cancel.abort();
    defaultHttpInstance.interceptors.request.eject(interceptor);
    agent.destroy();
  }
}

import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { object } from '../feishu/cards.js';
import { isMessageId, sdkTransport, type FeishuConfig, type FeishuToast, type FeishuTransport } from '../feishu/transport.js';
import { NotificationNotSent } from '../questions/model.js';

function testCard(token: string | null): string {
  const plain = (content: string) => ({ tag: 'plain_text', content });
  return JSON.stringify({ schema: '2.0', header: { title: plain('Codex Notify · 飞书连接测试') }, body: { elements: [
    { tag: 'div', text: plain(token ? '这张卡仅验证飞书收发，不会操作 Codex。' : '飞书发送与点击回调已确认。') },
    ...(token ? [{ tag: 'button', text: plain('确认收到测试卡'), type: 'primary',
      behaviors: [{ type: 'callback', value: { token, action: 'setup-test' } }] }] : []),
  ] } });
}

export async function verifyFeishuTestCard(config: FeishuConfig, onSent: () => void,
  transport: FeishuTransport = sdkTransport(config), timeoutMs = 8 * 60_000): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const clicked = Promise.withResolvers<boolean>();
  let messageId: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  function action(data: unknown): FeishuToast {
    const wrongCard: FeishuToast = { toast: { type: 'error', content: '此点击与当前测试卡不匹配。' } };
    if (!object(data) || !messageId) return wrongCard;
    const meta = object(data.header) ? data.header : data;
    const event = object(data.event) ? data.event : data;
    if ((meta.app_id !== undefined && meta.app_id !== config.appId) ||
        (meta.event_type !== undefined && meta.event_type !== 'card.action.trigger') ||
        !object(event.context) || event.context.open_message_id !== messageId ||
        (config.targetType === 'chat_id' && event.context.open_chat_id !== config.targetId) ||
        !object(event.action) || event.action.tag !== 'button' || !object(event.action.value) ||
        event.action.value.action !== 'setup-test' || event.action.value.token !== token) return wrongCard;
    if (!object(event.operator) || typeof event.operator.open_id !== 'string' ||
        !config.allowedOperatorIds.includes(event.operator.open_id))
      return { toast: { type: 'error', content: '请由配置中允许操作的用户点击。' } };
    clicked.resolve(true);
    return { toast: { type: 'info', content: '已收到测试回调。' } };
  }
  try {
    try { await transport.start(async data => action(data)); }
    catch { throw new Error('feishu_setup_connection_failed'); }
    try { messageId = await transport.create(testCard(token), randomUUID()); }
    catch (error) {
      throw new Error(error instanceof NotificationNotSent ? 'feishu_setup_card_rejected' : 'feishu_setup_card_send_unconfirmed');
    }
    if (!isMessageId(messageId)) throw new Error('feishu_setup_card_send_unconfirmed');
    onSent();
    timeout = setTimeout(() => clicked.resolve(false), timeoutMs);
    if (!await clicked.promise) throw new Error('feishu_setup_click_timeout');
    // The SDK must have a chance to return its callback response before disconnecting.
    await delay(500);
    try { await transport.patch(messageId, testCard(null)); } catch { /* The callback itself already confirmed receipt. */ }
  } finally {
    clearTimeout(timeout);
    await transport.stop();
  }
}

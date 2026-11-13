import type { Agent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as Lark from '@larksuiteoapi/node-sdk';
import { NotificationNotSent } from '../questions/model.js';

export type FeishuTargetType = 'open_id' | 'chat_id';
export type FeishuConnectionState = 'connecting' | 'online' | 'reconnecting' | 'connection-error' | 'stopped';
export type FeishuToast = { toast: { type: 'info' | 'error'; content: string } };
export type FeishuConfig = {
  appId: string;
  appSecret: string;
  targetType: FeishuTargetType;
  targetId: string;
  allowedOperatorIds: readonly string[];
  proxy?: URL | null;
  onConnectionState?: (state: FeishuConnectionState) => void;
};

export interface FeishuTransport {
  start(onAction: (data: unknown) => Promise<FeishuToast>): Promise<void>;
  stop(): Promise<void>;
  create(content: string, deliveryKey: string): Promise<string>;
  patch(messageId: string, content: string): Promise<void>;
}

const silent = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const HTTP_TIMEOUT = 10_000;
const START_TIMEOUT = 30_000;

function sdkHttp(agent: Agent, signal?: AbortSignal): Lark.HttpInstance {
  // SDK REST and WebSocket endpoint discovery use the same explicit transport
  // as the WebSocket handshake. Suppress Axios's separate environment lookup.
  const request: Lark.HttpInstance['request'] = <T = unknown, R = T, D = unknown>(opts: Lark.HttpRequestOptions<D>) =>
    // The SDK response interceptor unwraps AxiosResponse into the declared R.
    Lark.defaultHttpInstance.request<T, R, D>({
      ...opts, httpsAgent: agent, proxy: false, maxRedirects: 0, timeout: HTTP_TIMEOUT, signal,
    }) as Promise<R>;
  return {
    request,
    get: (url, opts) => request({ ...opts, url, method: 'GET' }),
    delete: (url, opts) => request({ ...opts, url, method: 'DELETE' }),
    head: (url, opts) => request({ ...opts, url, method: 'HEAD' }),
    options: (url, opts) => request({ ...opts, url, method: 'OPTIONS' }),
    post: (url, data, opts) => request({ ...opts, url, data, method: 'POST' }),
    put: (url, data, opts) => request({ ...opts, url, data, method: 'PUT' }),
    patch: (url, data, opts) => request({ ...opts, url, data, method: 'PATCH' }),
  };
}

// These message-create results explicitly reject the request before creating
// a message. Transport errors, missing IDs, and unfamiliar codes are uncertain.
const rejectedCreate = new Set([230001, 230002, 230006, 230013]);
const validMessageId = /^om_[A-Za-z0-9]{1,128}$/;

export function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && validMessageId.test(value);
}

/** Check REST authentication without opening a competing callback connection or sending a card. */
export async function probeFeishuAuth(config: FeishuConfig): Promise<boolean> {
  const agent = config.proxy ? new HttpsProxyAgent(config.proxy) : new HttpsAgent();
  try {
    const result = await sdkHttp(agent).post<unknown, { code?: number; tenant_access_token?: string }>(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: config.appId, app_secret: config.appSecret });
    return result?.code === 0 && !!result.tenant_access_token;
  } catch { return false; }
  finally { agent.destroy(); }
}

export function sdkTransport(config: FeishuConfig): FeishuTransport {
  const agent = config.proxy ? new HttpsProxyAgent(config.proxy) : new HttpsAgent();
  const httpInstance = sdkHttp(agent);
  const base = { appId: config.appId, appSecret: config.appSecret, domain: Lark.Domain.Feishu, logger: silent, httpInstance };
  const client = new Lark.Client(base);
  let ws: Lark.WSClient | undefined;
  let wsAbort: AbortController | undefined;
  let cancelStart: (() => void) | undefined;

  function state(next: FeishuConnectionState) {
    try { config.onConnectionState?.(next); } catch { /* A status observer must not affect transport. */ }
  }

  function close(client: Lark.WSClient) {
    if (ws !== client) return;
    ws = undefined;
    wsAbort?.abort();
    wsAbort = undefined;
    try { client.close({ force: true }); } finally { agent.destroy(); }
  }

  return {
    async start(onAction) {
      if (ws) throw new Error('Feishu channel is already active.');
      const ready = Promise.withResolvers<void>();
      const failure = () => ready.reject(new Error('Feishu long connection could not be established. Check the app configuration and network.'));
      const abort = new AbortController();
      let started = false;
      const socket = new Lark.WSClient({ ...base, agent, httpInstance: sdkHttp(agent, abort.signal), handshakeTimeoutMs: HTTP_TIMEOUT,
        onReady: () => { if (ws === socket) { started = true; state('online'); ready.resolve(); } },
        onReconnecting: () => { if (ws === socket) state('reconnecting'); },
        onReconnected: () => { if (ws === socket) state('online'); },
        onError: () => { if (ws === socket) { if (started) state('connection-error'); else failure(); } },
      });
      const action = async (data: unknown): Promise<FeishuToast> => ws === socket ? onAction(data) :
        { toast: { type: 'error', content: '当前无法提交，请稍后重试。' } };
      const dispatcher = new Lark.EventDispatcher({ logger: silent }).register({ 'card.action.trigger': action });
      ws = socket;
      wsAbort = abort;
      cancelStart = failure;
      const timer = setTimeout(failure, START_TIMEOUT);
      state('connecting');
      try {
        // WSClient.start may return before a successful reconnect. Only the
        // handshake callback makes this listener ready to accept card actions.
        void socket.start({ eventDispatcher: dispatcher }).catch(failure);
        await ready.promise;
      } catch {
        if (ws === socket) {
          close(socket);
          state('connection-error');
        }
        throw new Error('Feishu long connection could not be established. Check the app configuration and network.');
      } finally {
        clearTimeout(timer);
        if (cancelStart === failure) cancelStart = undefined;
      }
    },

    async stop() {
      cancelStart?.();
      if (ws) close(ws);
      state('stopped');
    },

    async create(content, deliveryKey) {
      let result: Awaited<ReturnType<typeof client.im.v1.message.create>>;
      try {
        result = await client.im.v1.message.create({ params: { receive_id_type: config.targetType }, data: {
          receive_id: config.targetId, msg_type: 'interactive', content, uuid: deliveryKey,
        } });
      } catch { throw new Error('Feishu notification outcome is unconfirmed.'); }
      if (result?.code === 0 && isMessageId(result.data?.message_id)) return result.data.message_id;
      if (result?.code !== undefined && rejectedCreate.has(result.code)) throw new NotificationNotSent('feishu_notification_rejected');
      throw new Error('Feishu notification outcome is unconfirmed.');
    },

    async patch(messageId, content) {
      try {
        const result = await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content } });
        if (result?.code === 0) return;
      } catch { /* SDK errors may include credentials or card content. */ }
      throw new Error('Feishu could not confirm the card update.');
    },
  };
}

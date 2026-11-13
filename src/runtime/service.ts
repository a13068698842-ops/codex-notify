import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:net';
import { THREAD_RE } from '../desktop/protocol.js';
import { FeishuChannel, type FeishuConnectionState } from '../feishu/channel.js';
import { QuestionCore } from '../questions/core.js';
import { loadQuestionRules } from '../questions/plain.js';
import { StateStore } from '../storage/store.js';
import { DesktopChats } from './desktop-chats.js';
import { runDaemon, type RuntimeDetails } from './lifecycle.js';
import { acquireFeishuAppLock } from './locks.js';
import { fromControl } from './registration.js';
import { dataDirectory, readInstalledFeishuConfig, readSettings } from './settings.js';

export async function runInstalledDaemon(): Promise<void> {
  let activeStore: StateStore | undefined;
  await runDaemon(async (signal, update) => {
    const settings = readSettings();
    if (!settings?.enabled) throw new Error('runtime_disabled_or_unconfigured');
    const rules = loadQuestionRules(settings.questionRulesPath ?? undefined);
    const store = activeStore = new StateStore(join(dataDirectory(), 'state.sqlite'));
    const desktop = new DesktopChats(store, rules);
    let feishu: FeishuConnectionState = 'stopped';
    let code: string | undefined;
    let channel: FeishuChannel | undefined;
    let core: QuestionCore | undefined;
    let coreClosing: Promise<void> | undefined;
    let lock: Server | undefined;
    let reconcile: Promise<void> | undefined;
    let retryAt = 0;
    let retryDelay = 2000;
    let reconnectBy = Infinity;
    let nextReconcile = 0;
    let lastHeartbeat = Date.now();
    let resetPending = false;
    // This timer runs even while connection setup is awaiting I/O.
    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastHeartbeat > 12_000) resetPending = true;
      lastHeartbeat = now;
    }, 1000);
    heartbeat.unref();

    const report = () => {
      const details: RuntimeDetails = {
        desktop: desktop.incompatible ? 'incompatible' : desktop.connected ? 'ready' : 'waiting',
        feishu: feishu === 'online' ? 'ready' : feishu === 'connection-error' || feishu === 'reconnecting' ? feishu : 'waiting',
        registered: store.listRegisteredChats().length, connected: desktop.connected,
        ...(channel ? store.runtimeCounts(channel.route) : {
          ...store.runtimeCounts({ channel: 'feishu', accountId: settings.channel.appId, targetId: settings.channel.targetId }),
        }),
        ...(code && { code }),
      };
      update(details);
    };
    const closeIntake = () => {
      if (!core) return;
      coreClosing = core.stop().catch(() => { code = 'runtime_cleanup_failed'; });
      core = undefined;
    };
    const stopCore = async () => {
      closeIntake();
      // Stop accepting actions first; release IPC so pending proofs/dispatches can settle.
      try { await desktop.pause(); await coreClosing; await reconcile; }
      finally { channel = undefined; coreClosing = undefined; reconcile = undefined; }
    };

    signal.addEventListener('abort', closeIntake, { once: true });
    try {
      report();
      while (!signal.aborted) {
        const now = Date.now();
        const resumed = resetPending;
        resetPending = false;
        if (core && (resumed || now >= reconnectBy)) {
          await stopCore();
          retryAt = 0;
        }
        desktop.resume();
        if (!core && !signal.aborted && now >= retryAt) {
          try {
            const config = readInstalledFeishuConfig(settings);
            lock ??= await acquireFeishuAppLock(config.appId);
            const newChannel: FeishuChannel = channel = new FeishuChannel({ ...config, onConnectionState: state => {
              feishu = state;
              if (state === 'online') { reconnectBy = Infinity; code = undefined; }
              if (state === 'reconnecting') reconnectBy = Date.now() + 45_000;
              if (state === 'connection-error') reconnectBy = Date.now() + 15_000;
            } }, selector => {
              const delivery = 'token' in selector ? store.findDelivery(selector.token)
                : store.findDeliveryByMessage(newChannel.route, selector.messageId);
              const question = delivery && store.getQuestion(delivery.questionId)?.question;
              if (!delivery || !question) return null;
              return { delivery, question, project: store.getSession(question.session)?.project };
            });
            const nextCore = new QuestionCore(store, desktop.port, newChannel, {
              route: newChannel.route, allowedOperatorIds: config.allowedOperatorIds, receiptTimeoutMs: settings.receiptTimeoutMs,
              canPublish: question => desktop.canPublish(question),
            });
            const interrupt = () => { void newChannel.stop().catch(() => {}); };
            if (signal.aborted) break;
            signal.addEventListener('abort', interrupt, { once: true });
            try { await nextCore.start(); core = nextCore; }
            finally { signal.removeEventListener('abort', interrupt); }
            retryDelay = 2000;
          } catch (error) {
            feishu = 'connection-error';
            const reason = error instanceof Error ? error.message : '';
            code = ['feishu_app_busy', 'windows_pac_requires_explicit_proxy', 'unsupported_proxy', 'windows_proxy_unreadable',
              'credential_unreadable_or_invalid'].includes(reason) ? reason : 'feishu_start_failed';
            retryAt = Date.now() + retryDelay;
            retryDelay = Math.min(60_000, retryDelay * 2);
          }
        }
        const running = core;
        if (!signal.aborted) await desktop.tick(running && (question => running.addQuestion(question)));
        if (running && !signal.aborted) {
          if (now >= nextReconcile && !reconcile) {
            nextReconcile = now + 15_000;
            reconcile = running.reconcile({ retryFailedDeliveries: false })
              .catch(() => { code = 'state_reconcile_failed'; })
              .finally(() => { reconcile = undefined; });
          }
        }
        report();
        await delay(1000, undefined, { signal }).catch(() => {});
      }
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener('abort', closeIntake);
      try { await stopCore(); }
      finally {
        try { if (lock) await new Promise<void>(resolve => lock!.close(() => resolve())); }
        finally { activeStore = undefined; store.close(); }
      }
    }
  }, (command, payload) => {
    if (!activeStore) throw new Error('registration_unavailable');
    if (command === 'register') {
      const registration = fromControl(payload);
      if (!registration) throw new Error('registration_invalid');
      activeStore.registerChat(registration);
    } else {
      const id = payload && typeof payload === 'object' && 'threadId' in payload ? payload.threadId : null;
      if (typeof id !== 'string' || !THREAD_RE.test(id)) throw new Error('registration_invalid');
      activeStore.unwatchChat(id.toLowerCase());
    }
  });
}

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopAdapter } from '../desktop/adapter.js';
import { discoverNativeQuestions, NativeDesktopPort } from '../desktop/native.js';
import { discoverPlainQuestion, PlainDesktopPort } from '../desktop/plain.js';
import { threadIdFrom } from '../desktop/protocol.js';
import { FeishuChannel } from '../feishu/channel.js';
import { QuestionCore } from '../questions/core.js';
import type { NewQuestion, SessionRef } from '../questions/model.js';
import { loadQuestionRules } from '../questions/plain.js';
import { StateStore } from '../storage/store.js';
import { readFeishuConfig } from './feishu-config.js';

function emit(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...details }));
}

type Mode = 'native' | 'plain';

// These local pipe names reserve the app and the test chat across foreground
// processes, including the earlier native-live runner; no control requests
// are read or accepted on either pipe.
async function lock(scope: string, mode: Mode): Promise<Server> {
  const suffix = createHash('sha256').update(scope).digest('hex').slice(0, 24);
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new Error(`${mode}_live_scope_busy`));
    server.once('error', onError);
    server.listen('\\\\.\\pipe\\codex-notify-native-' + suffix, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  return server;
}

function statePath(mode: Mode): string {
  const root = process.env.LOCALAPPDATA;
  if (!root) throw new Error('localappdata_required');
  const configured = process.env.CODEX_NOTIFY_TEST_STATE_DIR?.trim();
  if (configured) {
    const dir = resolve(configured);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${mode}.sqlite`);
  }
  const parent = join(root, 'CodexNotify', 'validation');
  mkdirSync(parent, { recursive: true });
  return join(mkdtempSync(join(parent, `${mode}-`)), `${mode}.sqlite`);
}

function configuredRules() {
  try { return loadQuestionRules(process.env.CODEX_NOTIFY_QUESTION_RULES?.trim() || undefined); }
  catch { throw new Error('question_rules_invalid'); }
}

export async function runForegroundLive(mode: Mode, thread: string, desktopVersion: string | null, signal: AbortSignal): Promise<void> {
  const session: SessionRef = { hostId: 'local', threadId: threadIdFrom(thread) };
  const rules = mode === 'plain' ? configuredRules() : null;
  const config = readFeishuConfig();
  const locks: Server[] = [];
  let store: StateStore | undefined;
  let core: QuestionCore | undefined;
  let adapter: DesktopAdapter | undefined;
  let connecting: Promise<DesktopAdapter> | undefined;
  let reconciliation: Promise<void> | undefined;
  let started = false;
  const connection = async (requested: SessionRef): Promise<DesktopAdapter> => {
    if (requested.hostId !== session.hostId || requested.threadId !== session.threadId)
      throw new Error('desktop_session_outside_test_scope');
    if (adapter?.ipc.isReady() && adapter.owner &&
        (adapter.health === 'ready' || adapter.health === 'revision_gap')) return adapter;
    if (!connecting) connecting = (async () => {
      if (adapter) await adapter.close();
      const next = new DesktopAdapter(session.threadId);
      adapter = next;
      try { await next.connect(); } catch {
        await next.close();
        adapter = undefined;
        throw new Error('desktop_owner_unavailable');
      }
      return next;
    })().finally(() => { connecting = undefined; });
    return connecting;
  };
  try {
    locks.push(await lock('app:' + config.appId, mode));
    locks.push(await lock('thread:' + session.threadId, mode));
    const live = await connection(session);
    signal.throwIfAborted();
    const initial = live.state!;
    const project = basename(initial.cwd) || '本机项目';
    const title = typeof initial.title === 'string' && initial.title.trim()
      ? initial.title : session.threadId.slice(0, 8);
    const dbPath = statePath(mode);
    const db = store = new StateStore(dbPath);
    const channel: FeishuChannel = new FeishuChannel({
      ...config, onConnectionState: state => emit('feishu_connection', { state }),
    }, selector => {
      const delivery = 'token' in selector
        ? db.findDelivery(selector.token) : db.findDeliveryByMessage(channel.route, selector.messageId);
      const record = delivery && db.getQuestion(delivery.questionId);
      if (!delivery || !record || record.question.session.threadId !== session.threadId) return null;
      return { delivery, question: record.question, project };
    });
    if (db.listSessions().some(row => row.session.threadId !== session.threadId) ||
        db.listDeliveries().some(({ route, questionId }) => route.channel !== channel.route.channel ||
          route.accountId !== channel.route.accountId || route.targetId !== channel.route.targetId ||
          db.getQuestion(questionId)?.question.kind !== mode))
      throw new Error(`${mode}_live_database_scope_mismatch`);
    db.upsertSession({ session, title, project, source: 'manual', enabled: true, transcriptPath: null, observedOffset: 0 });
    core = new QuestionCore(db, rules ? new PlainDesktopPort(connection, rules) : new NativeDesktopPort(connection), channel, {
      route: channel.route, allowedOperatorIds: config.allowedOperatorIds,
    });
    try { await core.start(); } catch { throw new Error('feishu_start_failed'); }
    started = true;
    emit(`${mode}_run_started`, { threadId: session.threadId, desktopVersion, dbPath });

    const evidence = new Map<string, string>();
    const report = () => {
      const attempts = new Map(db.listAttempts().map(attempt => [attempt.questionId, attempt]));
      for (const delivery of db.listDeliveries()) {
        const record = db.getQuestion(delivery.questionId);
        if (!record || record.question.kind !== mode) continue;
        const { question, status, version, code } = record;
        const attempt = attempts.get(question.id);
        const proof = attempt?.receipt;
        const line = {
          threadId: session.threadId, turnId: question.turnId,
          ...(question.kind === 'native'
            ? { callId: question.itemId, requestId: question.request.id }
            : { itemId: question.itemId, ruleId: question.ruleId, desktopOnly: !!question.desktopOnly,
                returnedTurnId: attempt?.returnedTurnId ?? null, clientUserMessageId: attempt?.clientUserMessageId ?? null,
                receiptUserItemId: proof?.kind === 'plain' ? proof.userItemId : null }),
          questionId: question.id, fieldCount: question.fields.length, messageId: delivery.message?.messageId ?? null,
          deliveryState: delivery.state, deliveryCode: delivery.code, status, code, version,
          publishedVersion: delivery.publishedVersion, attemptId: attempt?.id ?? null,
          attemptPhase: attempt?.phase ?? null, receiptTurnId: proof?.turnId ?? null,
          receiptCallId: proof?.kind === 'native' ? proof.callId : null,
        };
        const next = JSON.stringify(line);
        if (evidence.get(question.id) === next) continue;
        evidence.set(question.id, next);
        emit(`${mode}_question_state`, line);
      }
    };
    const discovered = new Set<string>();
    let desktopOnline = true;
    let nextReconcile = Date.now() + 15_000;
    while (!signal.aborted) {
      let state;
      try { state = await (await connection(session)).freshSnapshot(); } catch {
        if (desktopOnline) emit(`${mode}_desktop_connection`, { state: 'snapshot_unavailable' });
        desktopOnline = false;
      }
      if (signal.aborted) break;
      if (state) {
        if (!desktopOnline) emit(`${mode}_desktop_connection`, { state: 'ready' });
        desktopOnline = true;
        const plain = rules && discoverPlainQuestion(state, session, title, rules, project);
        const questions: NewQuestion[] = rules
          ? plain ? [{ ...plain.question, ruleId: plain.ruleId }] : []
          : discoverNativeQuestions(state, session, title, project);
        for (const question of questions) {
          const key = JSON.stringify([question.turnId, question.itemId, question.request?.id]);
          if (discovered.has(key)) continue;
          await core.addQuestion(question);
          discovered.add(key);
        }
      }
      if (Date.now() >= nextReconcile && !reconciliation) {
        // Retry proof and card synchronization in the background while following the desktop.
        nextReconcile = Date.now() + 15_000;
        reconciliation = core.reconcile({ retryFailedDeliveries: false }).catch(() => emit(`${mode}_reconcile_failed`))
          .finally(() => { reconciliation = undefined; });
      }
      report();
      await delay(1000, undefined, { signal }).catch(() => {});
    }
    await core.stop();
    started = false;
    report();
  } finally {
    try {
      if (started) await core!.stop();
      await reconciliation;
    } finally {
      try { await adapter?.close(); } finally {
        try { store?.close(); } finally { for (const server of locks) server.close(); }
      }
    }
  }
}

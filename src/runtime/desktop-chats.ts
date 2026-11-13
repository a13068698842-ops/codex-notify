import { basename } from 'node:path';
import { DesktopAdapter } from '../desktop/adapter.js';
import { discoverAsyncQuestions, AsyncDesktopPort } from '../desktop/async.js';
import { discoverNativeQuestions, NativeDesktopPort } from '../desktop/native.js';
import { discoverPlainQuestion, PlainDesktopPort } from '../desktop/plain.js';
import type { ConversationState } from '../desktop/protocol.js';
import { localTranscriptPath, sameLocalPath } from '../desktop/transcript.js';
import type { DesktopPort, NewQuestion, SessionRef } from '../questions/model.js';
import type { QuestionRules } from '../questions/plain.js';
import type { RegisteredChat, StateStore } from '../storage/store.js';
import { transcriptBelongs } from './registration.js';

type Follower = {
  chat: RegisteredChat;
  adapter: DesktopAdapter;
  opening: Promise<DesktopAdapter>;
  current: boolean;
  revision: number | null;
  refreshAt: number;
  currentQuestions: Set<string>;
  publishedKeys: Set<string> | null;
};

function belongsToRegistration(chat: RegisteredChat, state: ConversationState): boolean {
  return !!chat.cwd && sameLocalPath(chat.cwd, state.cwd) &&
    (!chat.transcriptPath || (!state.rolloutPath || (typeof state.rolloutPath === 'string' &&
      sameLocalPath(chat.transcriptPath, state.rolloutPath))) &&
      transcriptBelongs({ threadId: chat.threadId, cwd: state.cwd, transcriptPath: chat.transcriptPath }));
}

function questionKey(question: NewQuestion): string {
  return JSON.stringify([question.kind, question.turnId, question.itemId, question.request?.id]);
}

export class DesktopChats {
  private readonly followers = new Map<string, Follower>();
  private readonly chatJobs = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private readonly protocolErrors = new Set<string>();
  private paused = false;
  readonly port: DesktopPort;

  constructor(private readonly store: StateStore, private readonly rules: QuestionRules,
    private readonly makeAdapter = (threadId: string) => new DesktopAdapter(threadId)) {
    const getAdapter = (session: SessionRef) => this.connection(session);
    const native = new NativeDesktopPort(getAdapter);
    const plain = new PlainDesktopPort(getAdapter, rules);
    const ports: Record<NewQuestion['kind'], DesktopPort> = { native, plain, async: new AsyncDesktopPort(getAdapter) };
    this.port = {
      prepare: (question, attempt) => ports[question.kind].prepare(question, attempt),
      dispatch: (question, attempt) => ports[question.kind].dispatch(question, attempt),
      observeReceipt: (question, attempt, signal, saveMapping) =>
        ports[question.kind].observeReceipt(question, attempt, signal, saveMapping),
    };
  }

  get connected(): number {
    return [...this.followers.values()].filter(f => f.current && f.adapter.ipc.isReady() && f.adapter.health === 'ready').length;
  }

  get incompatible(): boolean { return this.protocolErrors.size > 0 ||
    [...this.followers.values()].some(f => f.adapter.health === 'incompatible'); }

  canPublish(question: NewQuestion): boolean {
    const follower = this.followers.get(question.session.threadId);
    return !this.paused && !!follower?.current && follower.adapter.ipc.isReady() &&
      follower.adapter.health === 'ready' && follower.revision === follower.adapter.revision &&
      follower.currentQuestions.has(questionKey(question));
  }

  private async release(follower: Follower): Promise<void> {
    if (follower.adapter.health === 'incompatible') this.protocolErrors.add(follower.chat.threadId);
    if (this.followers.get(follower.chat.threadId) === follower) this.followers.delete(follower.chat.threadId);
    follower.current = false;
    await follower.adapter.close().catch(() => {});
  }

  private async connection(session: SessionRef): Promise<DesktopAdapter> {
    const chat = this.store.getRegisteredChat(session.threadId);
    if (this.paused || session.hostId !== 'local' || !chat) throw new Error('desktop_not_registered');
    const previous = this.followers.get(chat.threadId);
    if (previous) {
      if (previous.chat.cwd === chat.cwd && previous.chat.transcriptPath === chat.transcriptPath &&
          (!previous.current || (previous.adapter.ipc.isReady() && previous.adapter.owner &&
            ['ready', 'revision_gap'].includes(previous.adapter.health)))) return previous.opening;
      await this.release(previous);
      return this.connection(session); // A parallel receipt or poll may have reconnected while the old adapter closed.
    }
    const adapter = this.makeAdapter(chat.threadId);
    const follower: Follower = { chat, adapter, current: false, revision: null, refreshAt: 0,
      opening: Promise.resolve(adapter), currentQuestions: new Set(), publishedKeys: null };
    this.followers.set(chat.threadId, follower);
    follower.opening = (async () => {
      try {
        const state = await adapter.connect();
        if (this.followers.get(chat.threadId) !== follower || !belongsToRegistration(chat, state))
          throw new Error('desktop_registration_mismatch');
        follower.current = true;
        this.protocolErrors.delete(chat.threadId);
        return adapter;
      } catch (error) {
        await this.release(follower);
        throw error;
      }
    })();
    return follower.opening;
  }

  async tick(add?: (question: NewQuestion) => Promise<unknown>): Promise<void> {
    if (this.paused) return;
    const rows = this.store.listRegisteredChats();
    const enabled = new Set(rows.map(row => row.threadId));
    for (const follower of this.followers.values()) if (!enabled.has(follower.chat.threadId)) await this.release(follower);
    for (const id of this.retryAt.keys()) if (!enabled.has(id)) this.retryAt.delete(id);
    for (const id of this.protocolErrors) if (!enabled.has(id)) this.protocolErrors.delete(id);
    const now = Date.now();
    for (const chat of rows) {
      if (this.chatJobs.has(chat.threadId) || now < (this.retryAt.get(chat.threadId) ?? 0)) continue;
      const job = this.inspect(chat, add).catch(() => { this.retryAt.set(chat.threadId, Date.now() + 5000); })
        .finally(() => this.chatJobs.delete(chat.threadId));
      this.chatJobs.set(chat.threadId, job);
    }
  }

  private async inspect(chat: RegisteredChat, add?: (question: NewQuestion) => Promise<unknown>): Promise<void> {
    const session: SessionRef = { hostId: 'local', threadId: chat.threadId };
    const adapter = await this.connection(session);
    const follower = this.followers.get(chat.threadId);
    if (this.paused || !follower || follower.adapter !== adapter) return;
    if (adapter.health === 'ready' && follower.revision === adapter.revision && Date.now() < follower.refreshAt &&
        (!add || follower.publishedKeys !== null)) return;
    let state: ConversationState;
    try { state = await adapter.freshSnapshot(); }
    catch (error) { await this.release(follower); throw error; }
    const active = this.store.getRegisteredChat(chat.threadId);
    if (this.paused || this.followers.get(chat.threadId) !== follower || !active ||
        active.cwd !== chat.cwd || active.transcriptPath !== chat.transcriptPath) return;
    if (!belongsToRegistration(chat, state)) {
      await this.release(follower);
      throw new Error('desktop_registration_mismatch');
    }
    follower.revision = adapter.revision;
    follower.refreshAt = Date.now() + 15_000;
    const project = basename(state.cwd) || '本机项目';
    const title = (typeof state.title === 'string' && state.title.trim()) || chat.threadId.slice(0, 8);
    const transcriptPath = localTranscriptPath(state.rolloutPath, chat.threadId) &&
      transcriptBelongs({ threadId: chat.threadId, cwd: state.cwd, transcriptPath: state.rolloutPath })
      ? state.rolloutPath : null;
    const existing = this.store.getSession(session);
    if (!existing?.enabled || existing.title !== title || existing.project !== project ||
        existing.source !== active.source || existing.transcriptPath !== transcriptPath) {
      this.store.upsertSession({ session, title, project, source: active.source, enabled: true,
        transcriptPath, observedOffset: existing?.observedOffset ?? 0 });
    }
    if (!add) { follower.currentQuestions.clear(); return; }
    const questions = discoverNativeQuestions(state, session, title, project);
    const plain = questions.length ? null : discoverPlainQuestion(state, session, title, this.rules, project);
    if (plain) questions.push({ ...plain.question, ruleId: plain.ruleId });
    questions.push(...discoverAsyncQuestions(state, session, title, project));
    follower.currentQuestions = new Set(questions.map(questionKey));
    for (const question of questions) {
      if (this.paused || !this.store.getSession(session)?.enabled) return;
      if (!follower.publishedKeys?.has(questionKey(question))) await add(question);
    }
    follower.publishedKeys = follower.currentQuestions;
  }

  async pause(): Promise<void> {
    this.paused = true;
    await Promise.all([...this.followers.values()].map(follower => this.release(follower)));
    await Promise.all(this.chatJobs.values());
    this.retryAt.clear();
    this.protocolErrors.clear();
  }

  resume(): void { this.paused = false; }
}

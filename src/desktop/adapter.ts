import { CodexDesktopIpcClient } from '../vendor/codex-mobile/codex/CodexDesktopIpcClient.js';
import { STATE_VERSION, NATIVE_VERSION, TEXT_VERSION, STEER_VERSION, threadIdFrom, validSnapshot,
  nativePayload, textPayload, steerPayload, type Frame, type ConversationState } from './protocol.js';

const quiet = { debug() {}, info() {}, warn() {} };
type Health = 'disconnected' | 'awaiting_snapshot' | 'ready' | 'incompatible' | 'revision_gap';
export class DesktopOwnerMismatch extends Error {}

export class DesktopAdapter {
  readonly threadId: string;
  readonly ipc: CodexDesktopIpcClient;
  owner: string | null = null;
  revision: number | null = null;
  state: ConversationState | null = null;
  health: Health = 'disconnected';
  private completeSnapshot: ConversationState | null = null;
  private responses = new Map<string, { owner: string | null } | null>();
  private snapshotWait: { promise: Promise<ConversationState>; resolve: (value: ConversationState) => void;
    reject: (error: Error) => void } | null = null;

  private belongsToThread(state: unknown): state is ConversationState {
    return validSnapshot(state) && state.id === this.threadId && state.sessionId === this.threadId &&
      state.hostId === 'local' && typeof state.cwd === 'string' &&
      (!state.rolloutPath || String(state.rolloutPath).toLowerCase().includes(this.threadId));
  }

  constructor(thread: string, ipc?: CodexDesktopIpcClient) {
    this.threadId = threadIdFrom(thread);
    this.ipc = ipc ?? new CodexDesktopIpcClient(quiet);
    const original = this.ipc.handleFrame.bind(this.ipc);
    this.ipc.handleFrame = (frame: Frame) => {
      if (frame.type === 'response' && typeof frame.requestId === 'string' && this.responses.get(frame.requestId) === null)
        this.responses.set(frame.requestId, { owner: typeof frame.handledByClientId === 'string' ? frame.handledByClientId : null });
      if (frame.type === 'broadcast' && frame.method === 'thread-stream-state-changed') {
        if (frame.params?.conversationId !== this.threadId) return;
        if (frame.version !== STATE_VERSION || frame.sourceClientId !== this.owner) {
          this.invalidate('incompatible'); return;
        }
        const change = frame.params?.change;
        if (change?.type === 'snapshot') {
          if (!Number.isSafeInteger(change.revision) || change.revision < 0 ||
              (this.revision !== null && change.revision < this.revision) ||
              !this.belongsToThread(change.conversationState)) {
            this.invalidate('incompatible'); return;
          }
          this.revision = change.revision;
          this.state = structuredClone(change.conversationState);
          this.completeSnapshot = this.state;
          this.health = 'ready';
          original(frame);
          this.snapshotWait?.resolve(this.state!);
          this.snapshotWait = null;
          return;
        }
        if (change?.type === 'patches') {
          if (this.health !== 'ready' || !Number.isSafeInteger(change.baseRevision) ||
              !Number.isSafeInteger(change.revision) || change.baseRevision !== this.revision ||
              change.revision <= change.baseRevision || !Array.isArray(change.patches)) {
            this.invalidate('revision_gap'); return;
          }
          // Upstream applies structural patches. Text may arrive separately; request a full
          // snapshot before any answer dispatch or receipt confirmation.
          this.completeSnapshot = null;
          original(frame);
          const next = this.ipc.getConversationState(this.threadId);
          if (!this.belongsToThread(next)) { this.invalidate('incompatible'); return; }
          this.state = next;
          this.revision = change.revision;
          return;
        }
        this.invalidate('incompatible'); return;
      }
      original(frame);
    };
    this.ipc.on('exited', () => this.invalidate('disconnected'));
  }

  private invalidate(reason: Health) {
    this.health = reason;
    this.revision = null;
    this.state = null;
    this.completeSnapshot = null;
    this.snapshotWait?.reject(new Error(reason));
    this.snapshotWait = null;
  }

  async connect() {
    await this.ipc.start();
    const id = crypto.randomUUID();
    this.responses.set(id, null);
    try {
      await this.ipc.sendFrame('thread-owner-discovery', { conversationId: this.threadId, hostId: 'local' },
        { requestId: id, timeoutMs: 5000 });
      this.owner = this.responses.get(id)?.owner ?? null;
    } finally { this.responses.delete(id); }
    if (!this.owner) throw new Error('No live local desktop owner.');
    this.health = 'awaiting_snapshot';
    return this.freshSnapshot();
  }

  async freshSnapshot(timeoutMs = 5000): Promise<ConversationState> {
    if (!this.ipc.isReady() || !this.owner || this.health === 'incompatible')
      throw new Error('Desktop snapshot unavailable.');
    if (this.snapshotWait) return this.snapshotWait.promise;
    const pending = Promise.withResolvers<ConversationState>();
    this.snapshotWait = pending;
    const timer = setTimeout(() => pending.reject(new Error('snapshot_timeout')), timeoutMs);
    try {
      this.ipc.writeFrame({ type: 'broadcast', sourceClientId: this.ipc.getClientId(),
        targetClientIds: [this.owner], method: 'thread-stream-following-changed', version: 1,
        params: { conversationId: this.threadId, hostId: 'local', following: true } });
    } catch (error) { pending.reject(error); }
    try { return await pending.promise; } finally {
      clearTimeout(timer);
      if (this.snapshotWait === pending) this.snapshotWait = null;
    }
  }

  async submitNative(requestId: string | number, answers: Record<string, { answers: string[] }>,
    bridgeRequestId: string, isCurrent: (state: ConversationState) => boolean): Promise<boolean> {
    const owner = this.owner;
    // Recheck the latest state, including patches that followed the fresh snapshot.
    if (!owner || !this.ipc.isReady() || this.health !== 'ready' || !this.state || !isCurrent(this.state)) return false;
    this.responses.set(bridgeRequestId, null);
    try {
      const result = await this.ipc.sendFrame('thread-follower-submit-user-input', nativePayload(this.threadId, requestId, answers),
        { version: NATIVE_VERSION, targetClientId: owner, requestId: bridgeRequestId, timeoutMs: 5000 });
      if (this.responses.get(bridgeRequestId)?.owner !== owner || this.owner !== owner || (result as any)?.ok !== true)
        throw new Error('Desktop owner did not acknowledge input.');
      return true; // Transport acknowledgement only.
    } finally { this.responses.delete(bridgeRequestId); }
  }

  async submitText(text: string, clientUserMessageId: string, bridgeRequestId: string,
    isCurrent: (state: ConversationState) => boolean): Promise<string | null> {
    return this.submitMessage('start', text, clientUserMessageId, bridgeRequestId, isCurrent);
  }

  async submitSteer(text: string, clientUserMessageId: string, bridgeRequestId: string,
    isCurrent: (state: ConversationState) => boolean): Promise<string | null> {
    return this.submitMessage('steer', text, clientUserMessageId, bridgeRequestId, isCurrent);
  }

  /** Ask the desktop owner to load older history. This does not post a message. */
  async loadCompleteHistory(): Promise<void> {
    const owner = this.owner;
    if (!owner || !this.ipc.isReady() || this.health !== 'ready') throw new Error('Desktop history unavailable.');
    const requestId = crypto.randomUUID();
    this.responses.set(requestId, null);
    try {
      await this.ipc.sendFrame('thread-follower-load-complete-history', { conversationId: this.threadId },
        { version: 1, targetClientId: owner, requestId, timeoutMs: 5000 });
      if (this.responses.get(requestId)?.owner !== owner || this.owner !== owner)
        throw new DesktopOwnerMismatch('Desktop owner did not acknowledge history load.');
    } finally { this.responses.delete(requestId); }
  }

  private async submitMessage(route: 'start' | 'steer', text: string, clientUserMessageId: string, bridgeRequestId: string,
    isCurrent: (state: ConversationState) => boolean): Promise<string | null> {
    const owner = this.owner;
    // The caller has just read a full snapshot. A newer patch may carry text that
    // upstream does not apply. Do not send from that incomplete cache.
    if (!owner || !this.ipc.isReady() || this.health !== 'ready' || !this.state ||
        this.state !== this.completeSnapshot || !isCurrent(this.state)) return null;
    this.responses.set(bridgeRequestId, null);
    try {
      const result = await this.ipc.sendFrame(route === 'steer' ? 'thread-follower-steer-turn' : 'thread-follower-start-turn',
        route === 'steer' ? steerPayload(this.threadId, text, clientUserMessageId, this.state.cwd)
          : textPayload(this.threadId, text, clientUserMessageId),
        { version: route === 'steer' ? STEER_VERSION : TEXT_VERSION, targetClientId: owner, requestId: bridgeRequestId, timeoutMs: 30_000 });
      if (this.responses.get(bridgeRequestId)?.owner !== owner || this.owner !== owner)
        throw new DesktopOwnerMismatch('Desktop owner did not acknowledge turn.');
      const value = (result as { result?: { turnId?: unknown; turn?: { id?: unknown } } } | null)?.result;
      const turnId = route === 'steer' ? value?.turnId : value?.turn?.id;
      if (typeof turnId !== 'string' || !turnId.trim()) throw new Error('Desktop owner did not acknowledge turn.');
      return turnId;
    } catch (error) {
      const response = this.responses.get(bridgeRequestId);
      if (response && response.owner !== owner) throw new DesktopOwnerMismatch('Desktop owner did not acknowledge turn.');
      throw error;
    } finally { this.responses.delete(bridgeRequestId); }
  }

  async close() {
    try {
      if (this.ipc.isReady() && this.owner) this.ipc.writeFrame({ type: 'broadcast',
        sourceClientId: this.ipc.getClientId(), targetClientIds: [this.owner],
        method: 'thread-stream-following-changed', version: 1,
        params: { conversationId: this.threadId, hostId: 'local', following: false } });
    } finally {
      this.owner = null;
      this.invalidate('disconnected');
      await this.ipc.stop();
    }
  }
}

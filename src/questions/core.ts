import { setImmediate as defer } from 'node:timers/promises';
import type { StateStore } from '../storage/store.js';
import { answerHash, asyncFieldId, NotificationNotSent, receiptMatches, sendPayload, validateAnswers,
  type Attempt, type ChannelSubmission, type Delivery, type DeliveryResult, type DesktopPort,
  type NewQuestion, type NotificationChannel, type Question, type QuestionRecord, type Receipt,
  type Route, type SubmissionAck } from './model.js';

export type CoreConfig = { route: Route; allowedOperatorIds: readonly string[]; receiptTimeoutMs?: number;
  canPublish?: (question: Question) => boolean };
type Lifecycle = 'stopped' | 'starting' | 'running' | 'stopping';

function sameRoute(a: Route, b: Route): boolean {
  return a.channel === b.channel && a.accountId === b.accountId && a.targetId === b.targetId;
}

function codeOr(code: string, fallback: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : fallback;
}

function validateQuestion(input: NewQuestion): void {
  const desktopOnly = input.desktopOnly === true;
  if (!input.turnId || !input.itemId || !input.prompt.trim() || (desktopOnly ? input.fields.length !== 0 : !input.fields.length) ||
      new Set(input.fields.map(field => field.id)).size !== input.fields.length ||
      input.fields.some(field => !field.id || !field.text.trim() ||
        field.options?.some(option => !option.label.trim()) ||
        (field.options && new Set(field.options.map(option => option.label)).size !== field.options.length)))
    throw new Error('Invalid question source or fields.');
  if (input.kind === 'async' && input.fields.some((field, index) =>
    !field.required || field.id !== asyncFieldId(input.itemId, index))) throw new Error('Invalid async question association.');
  if (input.kind === 'native' && (input.request.method !== 'item/tool/requestUserInput' ||
      !(typeof input.request.id === 'string' ? input.request.id.length > 0 : Number.isFinite(input.request.id))))
    throw new Error('Invalid native request.');
}

/** Coordinates one channel account and one route in the local process that owns the store. */
export class QuestionCore {
  private lifecycle: Lifecycle = 'stopped';
  private readonly route: Route;
  private readonly operators: Set<string>;
  private readonly receiptTimeoutMs: number;
  private readonly canPublish: NonNullable<CoreConfig['canPublish']>;
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly activeAttempts = new Set<string>();
  private readonly deliveryJobs = new Map<string, Promise<void>>();
  private readonly jobs = new Set<Promise<void>>();
  private stopObserving = new AbortController();
  private backgroundFailure: { error: unknown } | null = null;

  constructor(private readonly store: StateStore, private readonly desktop: DesktopPort,
    private readonly channel: NotificationChannel, config: CoreConfig) {
    this.route = { ...config.route };
    this.operators = new Set(config.allowedOperatorIds);
    this.canPublish = config.canPublish ?? (() => true);
    this.receiptTimeoutMs = config.receiptTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.receiptTimeoutMs) || this.receiptTimeoutMs < 1 || this.receiptTimeoutMs > 2_147_483_647)
      throw new RangeError('Invalid receipt timeout.');
  }

  async start(): Promise<void> {
    if (this.lifecycle !== 'stopped') throw new Error('Question core is already active.');
    this.lifecycle = 'starting';
    this.stopObserving = new AbortController();
    let channelStartAttempted = false;
    try {
      const { queued, uncertain } = this.store.recover();
      channelStartAttempted = true;
      await this.channel.start(submission => this.submit(submission));
      this.lifecycle = 'running';
      // Interrupted dispatches only observe; they can never reenter the dispatch path.
      for (const attempt of [...uncertain, ...queued]) this.enqueue(attempt);
      this.scheduleDeliveries(false);
    } catch (error) {
      this.lifecycle = 'stopping';
      this.stopObserving.abort();
      try {
        if (channelStartAttempted) await this.channel.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Core startup and channel cleanup failed.');
      } finally {
        this.lifecycle = 'stopped';
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycle === 'stopped') return;
    if (this.lifecycle !== 'running') throw new Error('Question core is changing state.');
    this.lifecycle = 'stopping';
    this.stopObserving.abort();
    try { await this.idle(); } finally {
      try { await this.channel.stop(); } finally { this.lifecycle = 'stopped'; }
    }
  }

  async addQuestion(input: NewQuestion): Promise<QuestionRecord> {
    if (this.lifecycle !== 'running') throw new Error('Question core is not running.');
    if (!this.store.getSession(input.session)?.enabled) throw new Error('Session is not registered and enabled.');
    validateQuestion(input);
    const { record, delivery } = this.store.putQuestionWithDelivery(input, this.route);
    if (delivery) await this.scheduleDelivery(delivery);
    return this.store.getQuestion(record.question.id)!;
  }

  async submit(input: ChannelSubmission): Promise<SubmissionAck> {
    if (this.lifecycle !== 'running') return { kind: 'rejected', code: 'unavailable' };
    if (input.channel !== this.route.channel || input.accountId !== this.route.accountId ||
        !input.operatorId || !this.operators.has(input.operatorId)) return { kind: 'rejected', code: 'unauthorized' };
    if (typeof input.token !== 'string' || typeof input.messageId !== 'string' ||
        (input.eventId !== undefined && (typeof input.eventId !== 'string' || !input.eventId)))
      return { kind: 'rejected', code: 'invalid_delivery' };
    const delivery = this.store.findDelivery(input.token);
    if (!delivery || !sameRoute(delivery.route, this.route) || !delivery.message ||
        delivery.message.messageId !== input.messageId) return { kind: 'rejected', code: 'invalid_delivery' };
    const record = this.store.getQuestion(delivery.questionId)!;
    if (!this.store.getSession(record.question.session)?.enabled) return { kind: 'rejected', code: 'session_disabled' };
    const answers = validateAnswers(record.question, input.answers);
    if (!answers) return { kind: 'rejected', code: 'invalid_answers' };
    const ack = this.store.claimSubmission(delivery.id, input, answers,
      answerHash(answers), sendPayload(record.question, answers));
    if (ack.kind === 'accepted') {
      this.enqueue(this.store.getAttempt(ack.attemptId)!);
      this.scheduleDelivery(delivery);
    }
    return ack;
  }

  async reconcile({ retryFailedDeliveries = true }: { retryFailedDeliveries?: boolean } = {}): Promise<void> {
    if (this.lifecycle !== 'running') return;
    for (const attempt of this.store.listUncertainAttempts()) this.enqueue(attempt);
    this.scheduleDeliveries(retryFailedDeliveries);
    await this.idle();
  }

  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.all(this.jobs);
    if (this.backgroundFailure) {
      const { error } = this.backgroundFailure;
      this.backgroundFailure = null;
      throw error;
    }
  }

  private track(job: Promise<void>): Promise<void> {
    const tracked = job.catch(error => { this.backgroundFailure ??= { error }; });
    this.jobs.add(tracked);
    void tracked.then(() => this.jobs.delete(tracked));
    return tracked;
  }

  private enqueue(attempt: Attempt): void {
    if (this.activeAttempts.has(attempt.id)) return;
    const { question } = this.store.getQuestion(attempt.questionId)!;
    const key = JSON.stringify([question.session.hostId, question.session.threadId]);
    this.activeAttempts.add(attempt.id);
    const previous = this.sessionQueues.get(key) ?? Promise.resolve();
    const work = previous.then(async () => {
      // Leave the channel callback free to acknowledge the committed submission.
      await defer();
      if (this.lifecycle === 'running') await this.runAttempt(question, attempt.id);
    }).finally(() => {
      this.activeAttempts.delete(attempt.id);
      if (this.sessionQueues.get(key) === job) this.sessionQueues.delete(key);
    });
    const job = this.track(work);
    this.sessionQueues.set(key, job);
  }

  private async runAttempt(question: Question, id: string): Promise<void> {
    let attempt = this.store.getAttempt(id)!;
    if (attempt.phase === 'unknown') {
      await this.observe(question, attempt);
      return;
    }
    if (attempt.phase !== 'queued') return;
    const permissionError = this.dispatchPermission(question, attempt);
    if (permissionError) {
      this.fail(attempt, permissionError);
      return;
    }
    let prepared: Awaited<ReturnType<DesktopPort['prepare']>>;
    try { prepared = await this.desktop.prepare(question, attempt); }
    catch { prepared = { kind: 'not_sent', code: 'desktop_unavailable' }; }
    if (this.lifecycle !== 'running') return; // Recovery can still run the queued attempt.
    if (prepared.kind !== 'ready') {
      this.fail(attempt, codeOr(prepared.code, 'desktop_unavailable'));
      return;
    }
    if (question.kind === 'async' && prepared.asyncRoute !== 'steer' && prepared.asyncRoute !== 'start') {
      this.fail(attempt, 'request_changed');
      return;
    }
    if (!this.store.getSession(question.session)?.enabled) {
      this.fail(attempt, 'session_disabled');
      return;
    }
    // The committed dispatching phase is the boundary after which a crash may have sent an answer.
    if (!this.store.beginDispatch(id, prepared.asyncRoute)) return;
    attempt = this.store.getAttempt(id)!;
    let result: Awaited<ReturnType<DesktopPort['dispatch']>>;
    try { result = await this.desktop.dispatch(question, attempt); }
    catch { result = { kind: 'uncertain', code: 'dispatch_unconfirmed' }; }
    if (result.kind === 'not_sent') {
      this.fail(attempt, codeOr(result.code, 'desktop_rejected'));
      return;
    }
    const turnMatches = result.kind === 'accepted' && (question.kind === 'native'
      ? result.turnId === undefined || result.turnId === question.turnId
      : typeof result.turnId === 'string' && !!result.turnId &&
        (attempt.asyncRoute === 'steer' ? result.turnId === question.turnId : result.turnId !== question.turnId));
    if (result.kind === 'accepted' && turnMatches) {
      this.store.markAwaitingReceipt(id, result.turnId ?? null);
    } else {
      this.store.markUnknown(id, result.kind === 'uncertain' ? codeOr(result.code, 'dispatch_unconfirmed') :
        question.kind === 'async' ? 'unexpected_turn' : 'dispatch_unconfirmed');
      this.publishDelivery(attempt.deliveryId);
    }
    await this.observe(question, this.store.getAttempt(id)!);
  }

  private dispatchPermission(question: Question, attempt: Attempt): string | null {
    if (!this.store.getSession(question.session)?.enabled) return 'session_disabled';
    const delivery = this.store.getDelivery(attempt.deliveryId);
    if (!delivery?.message || delivery.questionId !== question.id || !sameRoute(delivery.route, this.route))
      return 'invalid_delivery';
    return this.operators.has(attempt.operatorId) ? null : 'unauthorized';
  }

  private fail(attempt: Attempt, code: string): void {
    this.store.markFailed(attempt.id, code);
    this.publishDelivery(attempt.deliveryId);
  }

  private async observe(question: Question, attempt: Attempt): Promise<void> {
    if (question.kind === 'async' && ['unexpected_turn', 'desktop_owner_mismatch'].includes(attempt.code ?? '')) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.stopObserving.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.receiptTimeoutMs);
    let receipt: Receipt | null = null;
    let onAbort: (() => void) | undefined;
    try {
      if (!signal.aborted) {
        const aborted = new Promise<null>(resolve => {
          onAbort = () => resolve(null);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        receipt = await Promise.race([aborted, this.desktop.observeReceipt(question, attempt, signal,
          mapping => { if (!signal.aborted) this.store.saveAsyncMapping(attempt.id, mapping); })]);
      }
    } catch { /* A missing result is not evidence of rejection. */ }
    finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    if (receipt && !signal.aborted && receiptMatches(question, attempt, receipt)) {
      this.store.markAnswered(attempt.id, receipt);
      this.publishDelivery(attempt.deliveryId);
    } else if (attempt.phase === 'awaiting_receipt') {
      this.store.markUnknown(attempt.id, 'receipt_unconfirmed');
      this.publishDelivery(attempt.deliveryId);
    }
  }

  private publishDelivery(deliveryId: string): void {
    const delivery = this.store.getDelivery(deliveryId);
    if (delivery?.state === 'sent') this.scheduleDelivery(delivery);
  }

  private scheduleDeliveries(retryFailed: boolean): void {
    for (const delivery of this.store.listDeliveries()) this.scheduleDelivery(delivery, retryFailed);
  }

  private scheduleDelivery(delivery: Delivery, retryFailed = false): Promise<void> {
    const current = this.deliveryJobs.get(delivery.id);
    if (current) return current;
    if (!sameRoute(delivery.route, this.route)) return Promise.resolve();
    const work = Promise.resolve().then(() => this.syncDelivery(delivery.id, retryFailed));
    this.track(work);
    this.deliveryJobs.set(delivery.id, work);
    return work;
  }

  private async syncDelivery(id: string, retryFailed: boolean): Promise<void> {
    try {
      let delivery = this.store.getDelivery(id)!;
      if (delivery.state === 'pending' || (retryFailed && delivery.state === 'failed')) {
        if (this.lifecycle !== 'running') return;
        const { question, status } = this.store.getQuestion(delivery.questionId)!;
        if (status !== 'pending' || !this.store.getSession(question.session)?.enabled ||
            !this.canPublish(question) || !this.store.claimDelivery(delivery.id)) return;
        let result: DeliveryResult;
        try {
          const message = await this.channel.sendQuestion(question, delivery.token, delivery.id);
          result = message && sameRoute(message, delivery.route) && typeof message.messageId === 'string' && message.messageId
            ? { kind: 'sent', message } : { kind: 'unknown', code: 'notification_unconfirmed' };
        } catch (error) {
          result = error instanceof NotificationNotSent
            ? { kind: 'failed', code: codeOr(error.code, 'notification_failed') }
            : { kind: 'unknown', code: 'notification_unconfirmed' };
        }
        this.store.finishDelivery(delivery.id, result);
        delivery = this.store.getDelivery(id)!;
      }
      if (delivery.state !== 'sent' || !delivery.message) return;
      let published = delivery.publishedVersion;
      while (true) {
        const { status, version, code } = this.store.getQuestion(delivery.questionId)!;
        if (published >= version) return;
        try { await this.channel.updateQuestion(delivery.message, { status, version, code }); }
        catch { return; } // Version stays dirty. Reconciliation only updates the existing card.
        this.store.markPublished(delivery.id, version);
        published = version;
      }
    } finally {
      // Release the job in the same tick as the last version check.
      this.deliveryJobs.delete(id);
    }
  }
}

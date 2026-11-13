import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { validateAnswers, type Attempt, type DesktopPort, type NewQuestion, type Question, type QuestionField,
  type Receipt, type SessionRef } from '../questions/model.js';
import type { DesktopAdapter } from './adapter.js';
import { orderedTurns, validSnapshot, type ConversationState } from './protocol.js';
import { originalNativeRequestReleased, type NativeReceiptExpectation } from './receipts.js';
import { localTranscriptPath, NativeTranscriptCursor } from './transcript.js';

const method = 'item/tool/requestUserInput';
type Adapter = Pick<DesktopAdapter, 'threadId' | 'freshSnapshot' | 'submitNative'>;

function nonempty(input: unknown): input is string { return typeof input === 'string' && !!input.trim(); }

function isForSession(state: ConversationState, session: SessionRef): boolean {
  return validSnapshot(state) && state.hostId === 'local' && session.hostId === 'local' &&
    state.id === session.threadId && state.sessionId === session.threadId;
}

function parseFields(raw: any): QuestionField[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const fields: QuestionField[] = [];
  const ids = new Set<string>();
  for (const q of raw) {
    if (!nonempty(q?.id) || ids.has(q.id) || !nonempty(q.question) ||
        (q.isSecret !== undefined && q.isSecret !== false) ||
        (q.isOther !== undefined && typeof q.isOther !== 'boolean') ||
        (q.header !== undefined && typeof q.header !== 'string')) return null;
    const options: NonNullable<QuestionField['options']> = [];
    const labels = new Set<string>();
    if (q.options != null) {
      if (!Array.isArray(q.options)) return null;
      for (const option of q.options) {
        if (!nonempty(option?.label) || labels.has(option.label) ||
            (option.description !== undefined && typeof option.description !== 'string')) return null;
        labels.add(option.label);
        options.push({ label: option.label, ...(option.description !== undefined && { description: option.description }) });
      }
    }
    ids.add(q.id);
    fields.push({ id: q.id, text: nonempty(q.header) ? `${q.header}\n${q.question}` : q.question,
      options, required: true, allowOther: q.isOther === true || options.length === 0 });
  }
  return fields;
}

/** Recognize blocking native requests only, and never expose a partially understood form. */
export function discoverNativeQuestions(state: ConversationState, session: SessionRef, taskTitle: string,
  project?: string): NewQuestion[] {
  if (!isForSession(state, session)) return [];
  const ids = new Map<number | string, number>();
  for (const r of state.requests) if (r) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
  const activeTurns = new Set(orderedTurns(state).filter(t => t?.status === 'inProgress').map(t => t.turnId ?? t.id));
  const title = taskTitle.trim() || session.threadId.slice(0, 8);
  const questions: NewQuestion[] = [];
  for (const r of state.requests) {
    const p = r?.params;
    if (r?.method !== method || p?.isBlocking !== true || (p.threadId !== undefined && p.threadId !== session.threadId) ||
        !nonempty(p.turnId) || !activeTurns.has(p.turnId) || !nonempty(p.itemId) || p.networkApprovalContext ||
        !(nonempty(r.id) || (typeof r.id === 'number' && Number.isSafeInteger(r.id))) || ids.get(r.id) !== 1) continue;
    const fields = parseFields(p.questions);
    if (!fields) continue;
    questions.push({ kind: 'native', session, turnId: p.turnId, itemId: p.itemId, request: { method, id: r.id },
      taskTitle: nonempty(project) && project !== title ? `${title} · ${project}` : title,
      prompt: fields.map(f => f.text).join('\n\n'), fields });
  }
  return questions;
}

function isOriginalRequest(state: ConversationState, question: Extract<Question, { kind: 'native' }>): boolean {
  return discoverNativeQuestions(state, question.session, question.taskTitle).some(q =>
    q.kind === 'native' && q.turnId === question.turnId && q.itemId === question.itemId && q.request.id === question.request.id &&
    q.prompt === question.prompt && isDeepStrictEqual(q.fields, question.fields));
}

export class NativeDesktopPort implements DesktopPort {
  constructor(private readonly getAdapter: (session: SessionRef) => Promise<Adapter> | Adapter) {}

  private async adapter(session: SessionRef): Promise<Adapter> {
    const adapter = await this.getAdapter(session);
    if (adapter.threadId !== session.threadId) throw new Error('Desktop adapter does not own this session.');
    return adapter;
  }

  async prepare(question: Question, attempt: Attempt): ReturnType<DesktopPort['prepare']> {
    if (question.kind !== 'native' || attempt.payload.kind !== 'native' || question.id !== attempt.questionId)
      return { kind: 'not_sent', code: 'unsupported_question' };
    const state = await (await this.adapter(question.session)).freshSnapshot();
    return isOriginalRequest(state, question) ? { kind: 'ready' } : { kind: 'not_sent', code: 'request_changed' };
  }

  async dispatch(question: Question, attempt: Attempt): ReturnType<DesktopPort['dispatch']> {
    if (question.kind !== 'native' || attempt.payload.kind !== 'native' || question.id !== attempt.questionId)
      return { kind: 'not_sent', code: 'unsupported_question' };
    const payload = attempt.payload;
    if (!validateAnswers(question, payload.answers) || !isDeepStrictEqual(payload.answers, attempt.answers))
      return { kind: 'not_sent', code: 'invalid_answers' };
    let adapter: Adapter;
    try {
      adapter = await this.adapter(question.session);
      if (!isOriginalRequest(await adapter.freshSnapshot(), question)) return { kind: 'not_sent', code: 'request_changed' };
    } catch { return { kind: 'not_sent', code: 'desktop_unavailable' }; }
    try {
      const sent = await adapter.submitNative(question.request.id, payload.answers, attempt.bridgeRequestId,
        state => isOriginalRequest(state, question));
      return sent ? { kind: 'accepted', turnId: question.turnId } : { kind: 'not_sent', code: 'request_changed' };
    } catch { return { kind: 'uncertain', code: 'dispatch_unconfirmed' }; }
  }

  async observeReceipt(question: Question, attempt: Attempt, signal: AbortSignal): Promise<Receipt | null> {
    if (question.kind !== 'native' || attempt.payload.kind !== 'native' || question.id !== attempt.questionId) return null;
    const expected: NativeReceiptExpectation = { turnId: question.turnId, itemId: question.itemId,
      requestId: question.request.id, answers: attempt.payload.answers };
    let cursor: NativeTranscriptCursor | undefined;
    while (!signal.aborted) {
      try {
        const state = await (await this.adapter(question.session)).freshSnapshot();
        if (isForSession(state, question.session) && nonempty(state.cwd) &&
            localTranscriptPath(state.rolloutPath, question.session.threadId)) {
          if (!cursor || cursor.path !== state.rolloutPath || cursor.cwd !== state.cwd)
            cursor = new NativeTranscriptCursor(state.rolloutPath, state.cwd, question.session.threadId, expected);
          if (await cursor.matches(signal) && originalNativeRequestReleased(state, expected))
            return { kind: 'native', session: question.session, attemptId: attempt.id, turnId: expected.turnId, callId: expected.itemId };
        }
      } catch { /* Missing snapshot or rollout evidence is inconclusive; never replay the dispatch. */ }
      try { await delay(500, undefined, { signal }); } catch { break; }
    }
    return null;
  }
}

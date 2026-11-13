import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { sendPayload, validateAnswers, type Attempt, type DesktopPort, type NewQuestion,
  type Question, type Receipt, type SessionRef } from '../questions/model.js';
import { detectPlainQuestion, type QuestionRules } from '../questions/plain.js';
import type { DesktopAdapter } from './adapter.js';
import { hasStructuredQuestions } from './async.js';
import { orderedTurns, validSnapshot, type ConversationState } from './protocol.js';
import { textReceipt } from './receipts.js';

type Adapter = Pick<DesktopAdapter, 'threadId' | 'freshSnapshot' | 'submitText'>;
type PlainQuestion = Extract<NewQuestion, { kind: 'plain' }>;

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}

function isForSession(state: ConversationState, session: SessionRef): boolean {
  return validSnapshot(state) && state.hostId === 'local' && session.hostId === 'local' &&
    state.id === session.threadId && state.sessionId === session.threadId;
}

function turnId(turn: any): unknown { return turn?.turnId ?? turn?.id; }

/** Only inspect the latest turn, and never reinterpret structured questions as plain text. */
export function discoverPlainQuestion(state: ConversationState, session: SessionRef, taskTitle: string,
  rules: QuestionRules, project?: string): { question: PlainQuestion; ruleId: string } | null {
  if (!isForSession(state, session) || state.requests.length) return null;
  const turns = orderedTurns(state);
  const latest = turns.at(-1);
  const sourceTurn = turnId(latest);
  if (!nonempty(sourceTurn) || !Array.isArray(latest.items)) return null;
  const messages = latest.items.filter((item: any) => item?.type === 'agentMessage');
  const title = taskTitle.trim() || session.threadId.slice(0, 8);
  const base = { kind: 'plain' as const, session, turnId: sourceTurn,
    taskTitle: nonempty(project) && project !== title ? `${title} · ${project}` : title };

  // Some clients put async questions on a non-final message. Any populated
  // structured question in this turn excludes the ordinary start-turn path.
  if (messages.some(hasStructuredQuestions)) return null;

  if (latest.status !== 'completed' || (state.threadRuntimeStatus != null && state.threadRuntimeStatus.type !== 'idle') ||
      turns.some(turn => turn?.status === 'inProgress')) return null;
  const final = messages.at(-1);
  if (!nonempty(final?.id) || !nonempty(final.text) ||
      (final.phase != null && final.phase !== 'final_answer')) return null;
  const detected = detectPlainQuestion(final.text, rules);
  if (!detected) return null;
  const source = { ...base, itemId: final.id, prompt: detected.prompt };
  // The desktop also associates replies to an async message without populated
  // question fields with the message ID. That is not an ordinary next turn.
  if (final.delivery === 'async') return { ruleId: 'async-message',
    question: { ...source, prompt: final.text, fields: [], desktopOnly: true } };
  return { ruleId: detected.ruleId, question: detected.kind === 'question'
    ? { ...source, fields: detected.fields } : { ...source, fields: [], desktopOnly: true } };
}

export class PlainDesktopPort implements DesktopPort {
  constructor(private readonly getAdapter: (session: SessionRef) => Promise<Adapter> | Adapter,
    private readonly rules: QuestionRules) {}

  private async adapter(session: SessionRef): Promise<Adapter> {
    const adapter = await this.getAdapter(session);
    if (session.hostId !== 'local' || adapter.threadId !== session.threadId)
      throw new Error('Desktop adapter does not own this session.');
    return adapter;
  }

  private isOriginalQuestion(state: ConversationState, question: Question & PlainQuestion): boolean {
    const latest = discoverPlainQuestion(state, question.session, question.taskTitle, this.rules)?.question;
    return !!latest && !latest.desktopOnly && latest.turnId === question.turnId && latest.itemId === question.itemId &&
      latest.prompt === question.prompt && isDeepStrictEqual(latest.fields, question.fields);
  }

  async prepare(question: Question, attempt: Attempt): ReturnType<DesktopPort['prepare']> {
    if (question.kind !== 'plain' || question.desktopOnly || attempt.payload.kind !== 'plain' ||
        question.id !== attempt.questionId || !nonempty(attempt.clientUserMessageId) || !nonempty(attempt.bridgeRequestId))
      return { kind: 'not_sent', code: 'unsupported_question' };
    try {
      const state = await (await this.adapter(question.session)).freshSnapshot();
      return this.isOriginalQuestion(state, question) ? { kind: 'ready' } : { kind: 'not_sent', code: 'request_changed' };
    } catch { return { kind: 'not_sent', code: 'desktop_unavailable' }; }
  }

  async dispatch(question: Question, attempt: Attempt): ReturnType<DesktopPort['dispatch']> {
    if (question.kind !== 'plain' || question.desktopOnly || attempt.payload.kind !== 'plain' ||
        question.id !== attempt.questionId || !nonempty(attempt.clientUserMessageId) || !nonempty(attempt.bridgeRequestId))
      return { kind: 'not_sent', code: 'unsupported_question' };
    const answers = validateAnswers(question, attempt.answers);
    if (!answers || !isDeepStrictEqual(attempt.payload, sendPayload(question, answers)))
      return { kind: 'not_sent', code: 'invalid_answers' };
    let adapter: Adapter;
    try {
      adapter = await this.adapter(question.session);
      if (!this.isOriginalQuestion(await adapter.freshSnapshot(), question)) return { kind: 'not_sent', code: 'request_changed' };
    } catch { return { kind: 'not_sent', code: 'desktop_unavailable' }; }
    try {
      const acceptedTurn = await adapter.submitText(attempt.payload.text, attempt.clientUserMessageId, attempt.bridgeRequestId,
        state => this.isOriginalQuestion(state, question));
      if (acceptedTurn === null) return { kind: 'not_sent', code: 'request_changed' };
      if (!nonempty(acceptedTurn) || acceptedTurn === question.turnId)
        return { kind: 'uncertain', code: 'dispatch_unconfirmed' };
      return { kind: 'accepted', turnId: acceptedTurn };
    } catch { return { kind: 'uncertain', code: 'dispatch_unconfirmed' }; }
  }

  async observeReceipt(question: Question, attempt: Attempt, signal: AbortSignal): Promise<Receipt | null> {
    if (question.kind !== 'plain' || question.desktopOnly || attempt.payload.kind !== 'plain' ||
        question.id !== attempt.questionId || !nonempty(attempt.clientUserMessageId) ||
        !nonempty(attempt.returnedTurnId) || attempt.returnedTurnId === question.turnId) return null;
    const expected = { turnId: attempt.returnedTurnId, clientUserMessageId: attempt.clientUserMessageId,
      text: attempt.payload.text };
    while (!signal.aborted) {
      try {
        const state = await (await this.adapter(question.session)).freshSnapshot();
        if (signal.aborted) return null;
        if (isForSession(state, question.session)) {
          const turns = orderedTurns(state);
          const position = turns.findIndex(turn => turnId(turn) === expected.turnId);
          const original = position > 0 ? turns[position - 1] : null;
          if (turnId(original) === question.turnId && original.status === 'completed' &&
              Array.isArray(original.items) && original.items.some((item: any) =>
                item?.type === 'agentMessage' && item.id === question.itemId)) {
            const matched = textReceipt(state, expected);
            if (matched) return { kind: 'plain', session: question.session, attemptId: attempt.id,
              clientUserMessageId: expected.clientUserMessageId, ...matched };
          }
        }
      } catch { /* Missing snapshot or receipt evidence is inconclusive. Never send from here. */ }
      try { await delay(500, undefined, { signal }); } catch { break; }
    }
    return null;
  }
}

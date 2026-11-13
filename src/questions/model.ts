import { createHash } from 'node:crypto';

export type SessionRef = { hostId: 'local'; threadId: string };
export type SessionRecord = {
  session: SessionRef;
  title: string;
  project: string;
  source: 'hook' | 'manual';
  enabled: boolean;
  // Runtime only supplies transcript metadata verified against this session.
  transcriptPath: string | null;
  observedOffset: number;
};

export type AnswerMap = Record<string, { answers: string[] }>;
export type QuestionStatus = 'pending' | 'submitting' | 'answered' | 'failed' | 'unknown';
export type QuestionField = {
  id: string;
  text: string;
  options?: Array<{ label: string; description?: string }>;
  allowOther: boolean;
  required: boolean;
};

export type NewQuestion = {
  session: SessionRef;
  turnId: string;
  itemId: string;
  taskTitle: string;
  prompt: string;
  fields: QuestionField[];
} & (
  | { kind: 'native'; request: { method: 'item/tool/requestUserInput'; id: string | number }; desktopOnly?: never }
  | { kind: 'plain'; request?: never; ruleId?: string; desktopOnly?: true }
  | { kind: 'async'; request?: never; desktopOnly?: true }
);
export type Question = NewQuestion & { id: string };
export type QuestionView = { status: QuestionStatus; version: number; code: string | null };
export type QuestionRecord = QuestionView & { question: Question };

export type Route = { channel: string; accountId: string; targetId: string };
export type MessageRef = Route & { messageId: string };
export type Delivery = {
  id: string;
  questionId: string;
  route: Route;
  token: string;
  message: MessageRef | null;
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
  publishedVersion: number;
  code: string | null;
};
export type DeliveryResult =
  | { kind: 'sent'; message: MessageRef }
  | { kind: 'failed' | 'unknown'; code: string };

export type ChannelSubmission = {
  channel: string;
  accountId: string;
  eventId?: string;
  operatorId: string;
  messageId: string;
  token: string;
  answers: AnswerMap;
};
export type SubmissionAck =
  | { kind: 'accepted'; attemptId: string }
  | { kind: 'duplicate'; status: QuestionStatus }
  | { kind: 'rejected'; code: string };

export type AsyncRoute = 'steer' | 'start';
export type AsyncMessageMapping = { serverUserMessageId?: string; serverClientUserMessageId?: string };
export type SendPayload = { kind: 'native'; answers: AnswerMap } |
  { kind: 'plain'; text: string } | { kind: 'async'; text: string };
export type Receipt = { session: SessionRef; attemptId: string; turnId: string } & (
  | { kind: 'native'; callId: string }
  | { kind: 'plain'; clientUserMessageId: string; userItemId: string }
  | ({ kind: 'async'; route: AsyncRoute; sourceTurnId: string; sourceItemId: string;
    clientUserMessageId: string; userItemId: string;
    evidence: 'steeringUserMessage' | 'userMessage' } & AsyncMessageMapping)
);
export type Attempt = {
  id: string;
  questionId: string;
  deliveryId: string;
  eventId: string | null;
  operatorId: string;
  answerHash: string;
  answers: AnswerMap;
  payload: SendPayload;
  bridgeRequestId: string;
  clientUserMessageId: string | null;
  returnedTurnId: string | null;
  asyncRoute?: AsyncRoute;
  asyncMapping?: AsyncMessageMapping;
  phase: 'queued' | 'dispatching' | 'awaiting_receipt' | 'failed' | 'unknown' | 'answered';
  receipt: Receipt | null;
  code: string | null;
};

export interface DesktopPort {
  // Recheck the original association and dispatchability from a fresh snapshot. Must not send an answer.
  prepare(question: Question, attempt: Attempt): Promise<{ kind: 'ready'; asyncRoute?: AsyncRoute } |
    { kind: 'not_sent'; code: string }>;
  // Use the stored IDs and payload. Only return not_sent when non-delivery is certain.
  dispatch(question: Question, attempt: Attempt): Promise<
    { kind: 'accepted'; turnId?: string } | { kind: 'not_sent' | 'uncertain'; code: string }
  >;
  // Read only. Return proof only after matching the full persisted payload in the original session.
  observeReceipt(question: Question, attempt: Attempt, signal: AbortSignal,
    saveMapping?: (mapping: AsyncMessageMapping) => void): Promise<Receipt | null>;
}

export interface NotificationChannel {
  start(onSubmit: (submission: ChannelSubmission) => Promise<SubmissionAck>): Promise<void>;
  // Release connections/listeners even after a partial start failure; safe when already stopped.
  stop(): Promise<void>;
  sendQuestion(question: Question, token: string, deliveryKey: string): Promise<MessageRef>;
  updateQuestion(ref: MessageRef, view: QuestionView): Promise<void>;
}

// A channel may raise this only if it knows a message was not created. Generic errors are ambiguous.
export class NotificationNotSent extends Error {
  constructor(readonly code: string) { super('Notification was not sent.'); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateAnswers(question: Question, input: unknown): AnswerMap | null {
  if (question.desktopOnly) return null;
  if (!object(input) || Object.keys(input).some(key => !question.fields.some(field => field.id === key))) return null;
  const entries: [string, { answers: string[] }][] = [];
  for (const field of question.fields) {
    if (!Object.hasOwn(input, field.id)) {
      if (field.required) return null;
      continue;
    }
    const value = input[field.id];
    if (!object(value) || !Object.hasOwn(value, 'answers') || Object.keys(value).length !== 1 ||
        !Array.isArray(value.answers) || value.answers.length !== 1) return null;
    const answer: unknown = value.answers[0];
    if (typeof answer !== 'string' || !answer.trim()) return null;
    if (field.options?.length && !field.allowOther && !field.options.some(option => option.label === answer)) return null;
    entries.push([field.id, { answers: [answer] }]);
  }
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return entries.length ? Object.fromEntries(entries) : null;
}

export function answerHash(answers: AnswerMap): string {
  const ordered = Object.fromEntries(Object.keys(answers).sort().map(id => [id, answers[id]]));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export const asyncReplyOpen = '<send_user_message_question_reply>';
export const asyncReplyClose = '</send_user_message_question_reply>';

export function asyncFieldId(itemId: string, index: number): string {
  return JSON.stringify(['request_user_input_async', itemId, index]);
}

export function sendPayload(question: Question, answers: AnswerMap): SendPayload {
  if (question.kind === 'native') return { kind: 'native', answers };
  if (question.kind === 'async') {
    const replies = question.fields.map(field => ({
      questionItemId: field.id, question: field.text, answer: answers[field.id].answers[0],
    }));
    return { kind: 'async', text: `${asyncReplyOpen}\n${JSON.stringify(replies)}\n${asyncReplyClose}` };
  }
  const lines = question.fields.filter(field => Object.hasOwn(answers, field.id)).map(field =>
    question.fields.length === 1 ? answers[field.id].answers[0] : `${field.text}\n${answers[field.id].answers[0]}`);
  return { kind: 'plain', text: `Answer to the previous question:\n\n${lines.join('\n\n')}` };
}

export function receiptMatches(question: Question, attempt: Attempt, receipt: Receipt): boolean {
  if (attempt.questionId !== question.id || receipt.attemptId !== attempt.id || receipt.kind !== question.kind ||
      receipt.session?.hostId !== question.session.hostId || receipt.session?.threadId !== question.session.threadId ||
      typeof receipt.turnId !== 'string' || !receipt.turnId) return false;
  if (receipt.kind === 'native') return receipt.turnId === question.turnId && receipt.callId === question.itemId;
  if (receipt.kind === 'async') {
    if (question.kind !== 'async' || question.desktopOnly || attempt.payload.kind !== 'async' ||
        receipt.route !== attempt.asyncRoute || receipt.sourceTurnId !== question.turnId ||
        receipt.sourceItemId !== question.itemId ||
        (attempt.returnedTurnId !== null && attempt.returnedTurnId !== receipt.turnId) ||
        !attempt.clientUserMessageId || receipt.clientUserMessageId !== attempt.clientUserMessageId ||
        typeof receipt.userItemId !== 'string' || !receipt.userItemId.trim()) return false;
    return receipt.route === 'steer' ? receipt.turnId === question.turnId &&
      ['steeringUserMessage', 'userMessage'].includes(receipt.evidence) :
      receipt.route === 'start' && receipt.turnId !== question.turnId && receipt.evidence === 'userMessage';
  }
  return receipt.turnId !== question.turnId && attempt.returnedTurnId === receipt.turnId &&
    !!attempt.clientUserMessageId && receipt.clientUserMessageId === attempt.clientUserMessageId &&
    typeof receipt.userItemId === 'string' && !!receipt.userItemId;
}

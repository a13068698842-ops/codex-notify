import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { asyncFieldId, asyncReplyClose, asyncReplyOpen, sendPayload, validateAnswers,
  type AsyncMessageMapping, type AsyncRoute, type Attempt, type DesktopPort, type NewQuestion,
  type Question, type QuestionField, type Receipt, type SessionRef } from '../questions/model.js';
import { DesktopOwnerMismatch, type DesktopAdapter } from './adapter.js';
import { orderedTurns, validSnapshot, type ConversationState } from './protocol.js';
import { textReceipt } from './receipts.js';

type Adapter = Pick<DesktopAdapter, 'threadId' | 'freshSnapshot' | 'submitText' | 'submitSteer' | 'loadCompleteHistory'>;
type AsyncQuestion = Extract<NewQuestion, { kind: 'async' }>;

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}

function forSession(state: ConversationState, session: SessionRef): boolean {
  return validSnapshot(state) && state.hostId === 'local' && session.hostId === 'local' &&
    state.id === session.threadId && state.sessionId === session.threadId;
}

function turnId(turn: any): unknown { return turn?.turnId ?? turn?.id; }

export function hasStructuredQuestions(item: any): boolean {
  return item?.type === 'agentMessage' &&
    (Array.isArray(item.questions) ? item.questions.length > 0 : item.questions != null);
}

function fieldsFrom(item: any): QuestionField[] | null {
  if (!Array.isArray(item.questions) || !item.questions.length || item.isSecret === true ||
      (item.delivery != null && item.delivery !== 'async')) return null;
  const fields: QuestionField[] = [];
  for (const [index, field] of item.questions.entries()) {
    if (!nonempty(field?.title) || (field.options !== null && !Array.isArray(field.options)) ||
        Object.keys(field).some(key => key !== 'title' && key !== 'options' && !(key === 'isSecret' && field.isSecret === false)))
      return null;
    const options: unknown[] = field.options ?? [];
    if (!options.every(nonempty) || new Set(options).size !== options.length) return null;
    fields.push({ id: asyncFieldId(item.id, index), text: field.title, required: true, allowOther: true,
      ...(options.length ? { options: options.map(label => ({ label })) } : {}) });
  }
  return fields;
}

function acceptedSteering(item: any): boolean {
  return item?.type === 'steeringUserMessage' && (item.status === 'accepted' || item.steerAcknowledged === true);
}

function replyBody(item: any): string | null {
  const input = item?.type === 'userMessage' ? item.content : acceptedSteering(item) ? item.input : null;
  return Array.isArray(input) && input.length === 1 && input[0]?.type === 'text' &&
    typeof input[0].text === 'string' ? input[0].text : null;
}

function answeredFields(turns: any[]): Set<string> {
  const answered = new Set<string>();
  for (const turn of turns) for (const item of Array.isArray(turn?.items) ? turn.items : []) {
    const body = replyBody(item)?.trim();
    if (!body?.startsWith(asyncReplyOpen) || !body.endsWith(asyncReplyClose)) continue;
    try {
      const parsed = JSON.parse(body.slice(asyncReplyOpen.length, -asyncReplyClose.length));
      for (const reply of Array.isArray(parsed) ? parsed : [parsed]) {
        if (nonempty(reply?.questionItemId) && nonempty(reply?.question) && nonempty(reply?.answer))
          answered.add(reply.questionItemId);
      }
    } catch { /* Not a structured reply. */ }
  }
  return answered;
}

export function discoverAsyncQuestions(state: ConversationState, session: SessionRef, taskTitle: string,
  project?: string): AsyncQuestion[] {
  if (!forSession(state, session)) return [];
  const turns = orderedTurns(state);
  const running = turns.filter(turn => turn?.status === 'inProgress');
  const source = running.length ? (running.length === 1 ? running[0] : null) : turns.at(-1);
  const id = turnId(source);
  if (!nonempty(id) || !['inProgress', 'completed'].includes(source.status) || !Array.isArray(source.items)) return [];
  const answered = answeredFields(turns);
  const title = taskTitle.trim() || session.threadId.slice(0, 8);
  return source.items.filter((item: any) => hasStructuredQuestions(item) && nonempty(item.id) &&
    source.items.filter((other: any) => other?.id === item.id).length === 1).flatMap((item: any) => {
    const fields = fieldsFrom(item);
    // Desktop replies can answer individual fields. Do not open a new form that
    // would require the user to answer a field already handled on the desktop.
    if (Array.isArray(item.questions) && item.questions.some((_: unknown, index: number) =>
      answered.has(asyncFieldId(item.id, index)))) return [];
    const base = { kind: 'async' as const, session, turnId: id, itemId: item.id,
      taskTitle: nonempty(project) && project !== title ? `${title} · ${project}` : title };
    return fields ? [{ ...base, prompt: fields.map(field => field.text).join('\n\n'), fields }]
      : [{ ...base, prompt: '此问题需要在 Codex 桌面端回答。', fields: [], desktopOnly: true as const }];
  });
}

function originalTurn(turns: any[], question: Question & AsyncQuestion): any {
  const matches = turns.filter(turn => turnId(turn) === question.turnId);
  if (matches.length !== 1 || !Array.isArray(matches[0].items)) return null;
  const items = matches[0].items.filter((item: any) => item?.id === question.itemId);
  if (items.length !== 1 || !hasStructuredQuestions(items[0]) ||
      !isDeepStrictEqual(fieldsFrom(items[0]), question.fields)) return null;
  return matches[0];
}

function dispatchRoute(state: ConversationState, question: Question & AsyncQuestion): AsyncRoute | null {
  if (!forSession(state, question.session) || state.requests.some((request: any) =>
    // A retained plan prompt from an earlier turn does not block async input.
    request?.method !== 'item/plan/requestImplementation' || request.params?.turnId === question.turnId)) return null;
  const turns = orderedTurns(state);
  const source = originalTurn(turns, question);
  if (!source) return null;
  const answered = answeredFields(turns);
  if (question.fields.some(field => answered.has(field.id))) return null;
  const running = turns.filter(turn => turn?.status === 'inProgress');
  if (source.status === 'inProgress' && running.length === 1 && running[0] === source &&
      source === turns.at(-1) && state.threadRuntimeStatus?.type === 'active') return 'steer';
  if (source.status === 'completed' && !running.length && state.threadRuntimeStatus?.type === 'idle') return 'start';
  return null;
}

function eligible(question: Question, attempt: Attempt): question is Question & AsyncQuestion {
  if (question.kind !== 'async' || question.desktopOnly || question.id !== attempt.questionId ||
      attempt.payload.kind !== 'async' || !nonempty(attempt.bridgeRequestId) || !nonempty(attempt.clientUserMessageId)) return false;
  const answers = validateAnswers(question, attempt.answers);
  return !!answers && isDeepStrictEqual(sendPayload(question, answers), attempt.payload);
}

function steerEvidence(source: any, clientId: string, text: string, mapping?: AsyncMessageMapping):
  ({ userItemId: string; evidence: 'steeringUserMessage' | 'userMessage' } & AsyncMessageMapping) | null {
  if (source.itemsPagination?.hasLoadedOldest === false) return null;
  const clientIds = new Set([clientId, ...(mapping?.serverClientUserMessageId ? [mapping.serverClientUserMessageId] : [])]);
  const matches = source.items.filter((item: any) => item?.type === 'steeringUserMessage' ?
    item.clientUserMessageId === clientId ||
      (mapping?.serverUserMessageId && item.serverUserMessageId === mapping.serverUserMessageId) :
    item?.type === 'userMessage' && (clientIds.has(item.clientId) ||
      (mapping?.serverUserMessageId && item.id === mapping.serverUserMessageId)));
  if (matches.length !== 1) return null;
  const [item] = matches;
  if (!nonempty(item.id) || replyBody(item) !== text) return null;
  if (item.type === 'steeringUserMessage') {
    if (!acceptedSteering(item) || item.clientUserMessageId !== clientId ||
        (item.targetTurnId != null && item.targetTurnId !== turnId(source)) ||
        (mapping?.serverUserMessageId && item.serverUserMessageId != null && item.serverUserMessageId !== mapping.serverUserMessageId) ||
        (mapping?.serverClientUserMessageId && item.serverClientUserMessageId != null &&
          item.serverClientUserMessageId !== mapping.serverClientUserMessageId)) return null;
    return { userItemId: item.id, evidence: item.type, ...mapping,
      ...(nonempty(item.serverUserMessageId) ? { serverUserMessageId: item.serverUserMessageId } : {}),
      ...(nonempty(item.serverClientUserMessageId) ? { serverClientUserMessageId: item.serverClientUserMessageId } : {}) };
  }
  // The turn-level client ID belongs to the opening message, never to a steer.
  if ((item.clientId != null && !clientIds.has(item.clientId)) ||
      (mapping?.serverUserMessageId && item.id !== mapping.serverUserMessageId)) return null;
  return { userItemId: item.id, evidence: 'userMessage', ...mapping };
}

/** Match only the persisted payload and original question on the intended route. */
export function asyncReceipt(state: ConversationState, question: Question, attempt: Attempt):
  Extract<Receipt, { kind: 'async' }> | null {
  if (!eligible(question, attempt) || !forSession(state, question.session) || attempt.payload.kind !== 'async' ||
      !attempt.clientUserMessageId) return null;
  const turns = orderedTurns(state);
  const source = originalTurn(turns, question);
  if (!source) return null;
  const clientId = attempt.clientUserMessageId;
  const text = attempt.payload.text;
  const base = { kind: 'async' as const, session: question.session, attemptId: attempt.id,
    sourceTurnId: question.turnId, sourceItemId: question.itemId, clientUserMessageId: clientId };
  if (attempt.asyncRoute === 'steer') {
    if (attempt.returnedTurnId !== null && attempt.returnedTurnId !== question.turnId) return null;
    const proof = steerEvidence(source, clientId, text, attempt.asyncMapping);
    return proof && { ...base, ...proof, route: 'steer', turnId: question.turnId };
  }
  if (attempt.asyncRoute !== 'start' || source.status !== 'completed') return null;
  const after = turns.slice(turns.indexOf(source) + 1);
  // Without an ACK, uniqueness has to be checked over the entire range after
  // the original turn. A canonical history gap in that range is inconclusive.
  if (attempt.returnedTurnId === null && state.turnHistory?.kind === 'canonical') {
    const { islands, entitiesByKey } = state.turnHistory.history;
    if (!islands.at(-1)?.entries?.some((entry: any) => entitiesByKey[entry.value] === source)) return null;
  }
  const candidates = attempt.returnedTurnId !== null ? after.filter(turn => turnId(turn) === attempt.returnedTurnId) :
    after.filter(turn => turn?.params?.clientUserMessageId === clientId ||
      turn?.items?.some((item: any) => item?.type === 'userMessage' && item.clientId === clientId));
  if (candidates.length !== 1 || (attempt.returnedTurnId === null && after.some(turn =>
    !Array.isArray(turn?.items) || turn.itemsPagination?.hasLoadedOldest === false))) return null;
  const [target] = candidates;
  const targetId = turnId(target);
  if (!nonempty(targetId) || target.itemsPagination?.hasLoadedOldest === false) return null;
  const proof = textReceipt(state, { turnId: targetId, clientUserMessageId: clientId, text });
  return proof && { ...base, ...proof, route: 'start', evidence: 'userMessage' };
}

export class AsyncDesktopPort implements DesktopPort {
  constructor(private readonly getAdapter: (session: SessionRef) => Promise<Adapter> | Adapter) {}

  private async adapter(session: SessionRef): Promise<Adapter> {
    const adapter = await this.getAdapter(session);
    if (session.hostId !== 'local' || adapter.threadId !== session.threadId)
      throw new Error('Desktop adapter does not own this session.');
    return adapter;
  }

  async prepare(question: Question, attempt: Attempt): ReturnType<DesktopPort['prepare']> {
    if (!eligible(question, attempt)) return { kind: 'not_sent', code: 'unsupported_question' };
    try {
      const route = dispatchRoute(await (await this.adapter(question.session)).freshSnapshot(), question);
      return route ? { kind: 'ready', asyncRoute: route } : { kind: 'not_sent', code: 'request_changed' };
    } catch { return { kind: 'not_sent', code: 'desktop_unavailable' }; }
  }

  async dispatch(question: Question, attempt: Attempt): ReturnType<DesktopPort['dispatch']> {
    const route = attempt.asyncRoute;
    if (!eligible(question, attempt) || attempt.payload.kind !== 'async' || !attempt.clientUserMessageId ||
        (route !== 'start' && route !== 'steer')) return { kind: 'not_sent', code: 'unsupported_question' };
    const isCurrent = (state: ConversationState) => dispatchRoute(state, question) === route;
    let adapter: Adapter;
    try {
      adapter = await this.adapter(question.session);
      if (!isCurrent(await adapter.freshSnapshot())) return { kind: 'not_sent', code: 'request_changed' };
    } catch { return { kind: 'not_sent', code: 'desktop_unavailable' }; }
    try {
      const method = route === 'steer' ? 'submitSteer' : 'submitText';
      const target = await adapter[method](attempt.payload.text, attempt.clientUserMessageId, attempt.bridgeRequestId, isCurrent);
      return target === null ? { kind: 'not_sent', code: 'request_changed' } : { kind: 'accepted', turnId: target };
    } catch (error) {
      return { kind: 'uncertain', code: error instanceof DesktopOwnerMismatch ? 'desktop_owner_mismatch' : 'dispatch_unconfirmed' };
    }
  }

  async observeReceipt(question: Question, attempt: Attempt, signal: AbortSignal,
    saveMapping?: Parameters<DesktopPort['observeReceipt']>[3]): Promise<Receipt | null> {
    if (!eligible(question, attempt) || !attempt.asyncRoute) return null;
    let historyRequested: Adapter | null = null;
    while (!signal.aborted) {
      try {
        const adapter = await this.adapter(question.session);
        const state = await adapter.freshSnapshot();
        if (signal.aborted) return null;
        if (forSession(state, question.session)) {
          const proof = asyncReceipt(state, question, attempt);
          if (proof) {
            if (proof.evidence === 'steeringUserMessage') {
              const { serverUserMessageId, serverClientUserMessageId } = proof;
              if (serverUserMessageId || serverClientUserMessageId) saveMapping?.({
                ...(serverUserMessageId ? { serverUserMessageId } : {}),
                ...(serverClientUserMessageId ? { serverClientUserMessageId } : {}),
              });
            }
            return proof;
          }
          const turns = orderedTurns(state);
          const history = state.turnHistory?.history;
          const incomplete = (state.turnHistory?.kind === 'canonical' && (!history.isComplete || history.islands.length > 1)) ||
            state.turnsPagination?.hasLoadedOldest === false ||
            turns.some(turn => turn?.itemsPagination?.hasLoadedOldest === false);
          if (incomplete && state.threadRuntimeStatus?.type === 'idle' && historyRequested !== adapter) {
            historyRequested = adapter;
            await adapter.loadCompleteHistory();
          }
        }
      } catch { /* Missing or conflicting evidence is inconclusive. Never dispatch from here. */ }
      try { await delay(500, undefined, { signal }); } catch { break; }
    }
    return null;
  }
}

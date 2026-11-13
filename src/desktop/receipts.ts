import { orderedTurns, type ConversationState } from './protocol.js';
import { isDeepStrictEqual } from 'node:util';

export type NativeReceiptExpectation = {
  turnId: string; itemId: string; requestId: string | number;
  answers: Record<string, { answers: string[] }>;
};

// This is only a snapshot consistency check, not proof that an answer arrived.
// Exact tool output remains mandatory. A later task failure or interruption does
// not undo the answer already accepted by the original tool call.
export function originalNativeRequestReleased(state: ConversationState, expected: NativeReceiptExpectation): boolean {
  if (state.requests?.some((r: any) => r?.method === 'item/tool/requestUserInput' &&
    ((r.params?.turnId === expected.turnId && r.params?.itemId === expected.itemId) ||
      (r.id === expected.requestId && (!r.params?.turnId || !r.params?.itemId))))) return false;
  const turn = orderedTurns(state).find(t => (t.turnId ?? t.id) === expected.turnId);
  return !!turn && ['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status);
}

/** Consume only evidence for one call. Other turns cannot supply its result. */
export class NativeResultMatcher {
  private currentTurn: string | null = null;
  private callSeen = false;
  private outputSeen = false;
  matched = false;

  constructor(private readonly expected: NativeReceiptExpectation) {}

  resetTurn(): void { this.currentTurn = null; this.callSeen = false; }

  accept(row: any): void {
    if (this.outputSeen) return;
    const p = row?.payload;
    if (row?.type === 'turn_context') {
      const next = typeof p?.turn_id === 'string' ? p.turn_id : null;
      if (next !== this.currentTurn) this.callSeen = false;
      this.currentTurn = next;
    } else if (row?.type === 'event_msg' &&
        (['task_complete', 'turn_complete', 'turn_aborted'].includes(p?.type) ||
          (['task_started', 'turn_started'].includes(p?.type) && p.turn_id !== this.currentTurn))) {
      this.resetTurn();
    } else if (this.currentTurn === this.expected.turnId && row?.type === 'response_item' &&
        p?.call_id === this.expected.itemId) {
      if (p.type === 'function_call') this.callSeen = p.name === 'request_user_input';
      if (this.callSeen && p.type === 'function_call_output') {
        this.outputSeen = true;
        if (typeof p.output !== 'string') return;
        try {
          const parsed = JSON.parse(p.output);
          this.matched = parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length === 1 &&
            isDeepStrictEqual(parsed.answers, this.expected.answers);
        } catch { /* Unknown result format cannot confirm an answer. */ }
      }
    }
  }
}

export function nativeReceipt(state: ConversationState, transcript: unknown[], expected: NativeReceiptExpectation):
  { turnId: string; callId: string } | null {
  if (!originalNativeRequestReleased(state, expected)) return null;
  const matcher = new NativeResultMatcher(expected);
  for (const row of transcript) matcher.accept(row);
  return matcher.matched ? { turnId: expected.turnId, callId: expected.itemId } : null;
}

export function textReceipt(state: ConversationState, expected: {
  turnId: string; clientUserMessageId: string; text: string;
}): { turnId: string; userItemId: string } | null {
  const turns = orderedTurns(state).filter(turn => (turn?.turnId ?? turn?.id) === expected.turnId);
  if (turns.length !== 1 || !Array.isArray(turns[0].items)) return null;
  const turn = turns[0];
  const [user, ...later] = turn.items.filter((item: any) => item?.type === 'userMessage');
  // The turn's client ID applies only to the opening user message, never to
  // user messages added later by steering. An explicit item ID takes priority.
  if (!user || (user.clientId ?? turn.params?.clientUserMessageId) !== expected.clientUserMessageId ||
      later.some((item: any) => item.clientId === expected.clientUserMessageId)) return null;
  return typeof user.id === 'string' && !!user.id.trim() && Array.isArray(user.content) &&
    user.content.length === 1 && user.content[0]?.type === 'text' && user.content[0].text === expected.text
    ? { turnId: expected.turnId, userItemId: user.id } : null;
}

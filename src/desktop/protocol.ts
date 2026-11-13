export const STATE_VERSION = 11;
export const NATIVE_VERSION = 1;
export const TEXT_VERSION = 2;
export const STEER_VERSION = 1;
export const THREAD_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function threadIdFrom(input: string): string {
  const match = /^(?:codex:\/\/threads\/)?([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i.exec(input.trim());
  if (!match) throw new Error('Expected a local desktop thread UUID or codex://threads/<UUID>.');
  return match[1].toLowerCase();
}

export type Frame = Record<string, any>;
export type ConversationState = Record<string, any>;

export function validSnapshot(state: unknown): state is ConversationState {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const s = state as ConversationState;
  return Array.isArray(s.requests) &&
    (Array.isArray(s.turns) || (s.turnHistory?.kind === 'canonical' &&
      Array.isArray(s.turnHistory.history?.islands) &&
      s.turnHistory.history?.entitiesByKey && typeof s.turnHistory.history.entitiesByKey === 'object'));
}

export function orderedTurns(state: ConversationState): any[] {
  if (state.turnHistory?.kind === 'canonical') {
    const history = state.turnHistory.history;
    return history.islands.flatMap((island: any) => (island.entries ?? [])
      .map((entry: any) => history.entitiesByKey[entry.value]).filter(Boolean));
  }
  return Array.isArray(state.turns) ? state.turns : [];
}

export function nativePayload(threadId: string, requestId: string | number, answers: Record<string, { answers: string[] }>) {
  return { conversationId: threadId, requestId, response: { answers } };
}

export function textPayload(threadId: string, text: string, clientUserMessageId: string) {
  return { conversationId: threadId, turnStart: {
    request: { threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId },
    context: { attachments: [], inheritThreadSettings: true },
  } };
}

export function steerPayload(threadId: string, text: string, clientUserMessageId: string, cwd: string) {
  return { conversationId: threadId, clientUserMessageId,
    input: [{ type: 'text', text, text_elements: [] }], attachments: [],
    restoreMessage: { id: clientUserMessageId, text, cwd, createdAt: Date.now(), context: {
      prompt: text, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: [cwd],
    } } };
}

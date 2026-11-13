import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { receiptMatches } from '../questions/model.js';
import type {
  AnswerMap, AsyncMessageMapping, AsyncRoute, Attempt, ChannelSubmission, Delivery, DeliveryResult, MessageRef, NewQuestion, Question,
  QuestionRecord, QuestionStatus, Receipt, Route, SendPayload, SessionRecord, SessionRef, SubmissionAck,
} from '../questions/model.js';
import { migrations } from './schema.js';

type Row = Record<string, SQLOutputValue>;
type AttemptPhase = Attempt['phase'];

function readSession(row: Row): SessionRecord {
  return {
    session: { hostId: row.host_id as SessionRef['hostId'], threadId: row.thread_id as string },
    title: row.title as string,
    project: row.project as string,
    source: row.source as SessionRecord['source'],
    enabled: row.enabled === 1,
    transcriptPath: row.transcript_path as string | null,
    observedOffset: row.observed_offset as number,
  };
}

function readQuestion(row: Row): QuestionRecord {
  return {
    question: JSON.parse(row.frozen_json as string) as Question,
    status: row.status as QuestionStatus,
    version: row.version as number,
    code: row.code as string | null,
  };
}

function readDelivery(row: Row): Delivery {
  const route = { channel: row.channel as string, accountId: row.account_id as string, targetId: row.target_id as string };
  return {
    id: row.id as string,
    questionId: row.question_id as string,
    route,
    token: row.token as string,
    message: row.message_id === null ? null : { ...route, messageId: row.message_id as string },
    state: row.state as Delivery['state'],
    publishedVersion: row.published_version as number,
    code: row.code as string | null,
  };
}

function readAttempt(row: Row): Attempt {
  return {
    id: row.id as string,
    questionId: row.question_id as string,
    deliveryId: row.delivery_id as string,
    eventId: row.event_id as string | null,
    operatorId: row.operator_id as string,
    answerHash: row.answer_hash as string,
    answers: JSON.parse(row.answers_json as string) as AnswerMap,
    payload: JSON.parse(row.payload_json as string) as SendPayload,
    bridgeRequestId: row.bridge_request_id as string,
    clientUserMessageId: row.client_user_message_id as string | null,
    returnedTurnId: row.returned_turn_id as string | null,
    ...(row.async_route !== null ? { asyncRoute: row.async_route as AsyncRoute } : {}),
    ...(row.async_mapping_json !== null ? { asyncMapping: JSON.parse(row.async_mapping_json as string) as AsyncMessageMapping } : {}),
    phase: row.phase as AttemptPhase,
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json as string) as Receipt,
    code: row.code as string | null,
  };
}

export type RegisteredChat = { threadId: string; cwd: string | null; transcriptPath: string | null;
  source: 'hook' | 'manual'; enabled: boolean };

function readRegisteredChat(row: Record<string, unknown>): RegisteredChat {
  return { threadId: row.thread_id as string, cwd: row.cwd as string | null,
    transcriptPath: row.transcript_path as string | null, source: row.source as RegisteredChat['source'], enabled: true };
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const version = () => this.db.prepare('PRAGMA user_version').get()!.user_version as number;
      const before = version();
      if (before < 0 || before > migrations.length) throw new Error('Unsupported state database version.');
      if (before < migrations.length) {
        // VACUUM INTO captures committed WAL data too. Keep the backup next to
        // the database in the same private data directory.
        if (before > 0 && file !== ':memory:')
          this.db.prepare('VACUUM INTO ?').run(`${file}.v${before}.${randomUUID()}.bak`);
        this.db.exec('PRAGMA foreign_keys = OFF');
        try {
          this.transaction(() => {
            for (let i = version(); i < migrations.length; i++) {
              this.db.exec(migrations[i]);
              this.db.exec(`PRAGMA user_version = ${i + 1}`);
            }
            if (this.db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid migrated state references.');
          });
        } finally { this.db.exec('PRAGMA foreign_keys = ON'); }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }

  upsertSession(record: SessionRecord): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sessions (host_id, thread_id, title, project, source, enabled, transcript_path, observed_offset,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (host_id, thread_id) DO UPDATE SET title=excluded.title, project=excluded.project,
        source=excluded.source, enabled=excluded.enabled, transcript_path=excluded.transcript_path,
        observed_offset=excluded.observed_offset, updated_at=excluded.updated_at
    `).run(record.session.hostId, record.session.threadId, record.title, record.project, record.source,
      Number(record.enabled), record.transcriptPath, record.observedOffset, now, now);
  }

  getSession(ref: SessionRef): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE host_id=? AND thread_id=?').get(ref.hostId, ref.threadId);
    return row ? readSession(row) : null;
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY host_id, thread_id').all().map(readSession);
  }

  registerChat(chat: Omit<RegisteredChat, 'enabled'>): void {
    this.db.prepare(`
      INSERT INTO registrations (thread_id, cwd, transcript_path, source, enabled) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (thread_id) DO UPDATE SET cwd=excluded.cwd,
        transcript_path=COALESCE(excluded.transcript_path,
          CASE WHEN registrations.cwd=excluded.cwd THEN registrations.transcript_path END),
        source=CASE WHEN registrations.source='manual' THEN 'manual' ELSE excluded.source END, enabled=1
      WHERE registrations.enabled=1 OR excluded.source='manual'
    `).run(chat.threadId, chat.cwd, chat.transcriptPath, chat.source);
  }

  unwatchChat(threadId: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO registrations (thread_id, cwd, transcript_path, source, enabled) VALUES (?, NULL, NULL, 'manual', 0)
        ON CONFLICT (thread_id) DO UPDATE SET enabled=0
      `).run(threadId);
      this.db.prepare("UPDATE sessions SET enabled=0 WHERE host_id='local' AND thread_id=?").run(threadId);
    });
  }

  listRegisteredChats(): RegisteredChat[] {
    return this.db.prepare('SELECT thread_id,cwd,transcript_path,source FROM registrations WHERE enabled=1').all()
      .map(readRegisteredChat);
  }

  getRegisteredChat(threadId: string): RegisteredChat | null {
    const row = this.db.prepare('SELECT thread_id,cwd,transcript_path,source FROM registrations WHERE thread_id=? AND enabled=1')
      .get(threadId);
    return row ? readRegisteredChat(row) : null;
  }

  runtimeCounts(route: Route): { failed: number; unknown: number } {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(q.status='failed' OR d.state='failed'), 0) AS failed,
             COALESCE(SUM(q.status='unknown' OR d.state='unknown'), 0) AS unknown
      FROM deliveries d JOIN questions q ON d.question_id=q.id
      WHERE d.channel=? AND d.account_id=? AND d.target_id=?
    `).get(route.channel, route.accountId, route.targetId)!;
    return { failed: Number(row.failed), unknown: Number(row.unknown) };
  }

  putQuestionWithDelivery(newQuestion: NewQuestion, route: Route): { record: QuestionRecord; delivery: Delivery | null } {
    return this.transaction(() => {
      if (newQuestion.kind === 'async') {
        const legacy = this.db.prepare(`
          SELECT * FROM questions WHERE host_id=? AND thread_id=? AND turn_id=? AND item_id=?
            AND kind='plain' AND json_extract(frozen_json, '$.ruleId')='structured-async'
            AND json_extract(frozen_json, '$.desktopOnly')=1
        `).get(newQuestion.session.hostId, newQuestion.session.threadId, newQuestion.turnId, newQuestion.itemId);
        if (legacy) return { record: readQuestion(legacy), delivery: null };
      }
      const record = this.insertQuestion(newQuestion);
      const delivery = this.insertDelivery(record.question.id, route);
      return { record, delivery };
    });
  }

  private insertQuestion(newQuestion: NewQuestion): QuestionRecord {
    const request = newQuestion.kind === 'native' ? newQuestion.request : null;
    const requestType = request ? typeof request.id : '';
    if (request && typeof request.id === 'number' && !Number.isFinite(request.id))
      throw new Error('Invalid native request ID.');
    const key = [newQuestion.session.hostId, newQuestion.session.threadId, newQuestion.turnId, newQuestion.itemId,
      newQuestion.kind, request?.method ?? '', requestType, request ? JSON.stringify(request.id) : ''] as const;
    const question: Question = { ...newQuestion, id: randomUUID() };
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO questions (host_id, thread_id, turn_id, item_id, kind, request_method, request_id_type,
        request_id_json, id, frozen_json, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (host_id, thread_id, turn_id, item_id, kind, request_method, request_id_type, request_id_json)
      DO NOTHING
    `).run(...key, question.id, JSON.stringify(question), now, now);
    const row = this.db.prepare(`
      SELECT * FROM questions WHERE host_id=? AND thread_id=? AND turn_id=? AND item_id=?
        AND kind=? AND request_method=? AND request_id_type=? AND request_id_json=?
    `).get(...key)!;
    return readQuestion(row);
  }

  getQuestion(id: string): QuestionRecord | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id=?').get(id);
    return row ? readQuestion(row) : null;
  }

  private insertDelivery(questionId: string, route: Route): Delivery {
    const key = [questionId, route.channel, route.accountId, route.targetId] as const;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO deliveries (question_id, channel, account_id, target_id, id, token, state, published_version,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (question_id, channel, account_id, target_id) DO NOTHING
    `).run(...key, randomUUID(), randomBytes(32).toString('base64url'), now, now);
    return readDelivery(this.db.prepare(`
      SELECT * FROM deliveries WHERE question_id=? AND channel=? AND account_id=? AND target_id=?
    `).get(...key)!);
  }

  getDelivery(id: string): Delivery | null {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
    return row ? readDelivery(row) : null;
  }

  findDelivery(token: string): Delivery | null {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE token=?').get(token);
    return row ? readDelivery(row) : null;
  }

  findDeliveryByMessage(route: Route, messageId: string): Delivery | null {
    const row = this.db.prepare(`SELECT * FROM deliveries
      WHERE channel=? AND account_id=? AND message_id=? AND target_id=?`)
      .get(route.channel, route.accountId, messageId, route.targetId);
    return row ? readDelivery(row) : null;
  }

  listDeliveries(): Delivery[] {
    return this.db.prepare('SELECT * FROM deliveries ORDER BY rowid').all().map(readDelivery);
  }

  claimDelivery(id: string): boolean {
    return this.db.prepare(`
      UPDATE deliveries SET state='sending', code=NULL, updated_at=? WHERE id=? AND state IN ('pending', 'failed')
    `).run(Date.now(), id).changes === 1;
  }

  finishDelivery(id: string, result: DeliveryResult): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
      if (!row || row.state !== 'sending') return;
      let message: MessageRef | null = null;
      let state: Delivery['state'] = result.kind;
      let code: string | null = result.kind === 'sent' ? null : result.code;
      if (result.kind === 'sent') {
        message = result.message;
        if (!message || row.channel !== message.channel || row.account_id !== message.accountId ||
            row.target_id !== message.targetId || !message.messageId) {
          code = 'notification_route_mismatch';
        } else if (this.db.prepare(`
          SELECT 1 FROM deliveries WHERE channel=? AND account_id=? AND message_id=? AND id<>?
        `).get(message.channel, message.accountId, message.messageId, id)) {
          code = 'notification_message_conflict';
        }
        if (code) {
          state = 'unknown';
          message = null;
        }
      }
      this.db.prepare('UPDATE deliveries SET state=?, message_id=?, code=?, updated_at=? WHERE id=?')
        .run(state, message?.messageId ?? null, code, Date.now(), id);
    });
  }

  markPublished(id: string, version: number): void {
    this.db.prepare(`
      UPDATE deliveries SET published_version=?, updated_at=? WHERE id=? AND state='sent'
        AND published_version < ? AND ? <= (SELECT q.version FROM questions q WHERE q.id=deliveries.question_id)
    `).run(version, Date.now(), id, version, version);
  }

  claimSubmission(deliveryId: string, submission: ChannelSubmission, answers: AnswerMap, answerHash: string,
    payload: SendPayload): SubmissionAck {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT d.*, q.status AS question_status, q.kind AS question_kind, s.enabled AS session_enabled
        FROM deliveries d JOIN questions q ON q.id=d.question_id
        JOIN sessions s ON s.host_id=q.host_id AND s.thread_id=q.thread_id WHERE d.id=?
      `).get(deliveryId);
      if (!row || row.state !== 'sent' || row.channel !== submission.channel || row.account_id !== submission.accountId ||
          row.message_id !== submission.messageId || row.token !== submission.token) {
        return { kind: 'rejected', code: 'message_mismatch' };
      }
      if (row.session_enabled !== 1) return { kind: 'rejected', code: 'session_disabled' };
      if (payload.kind !== row.question_kind) return { kind: 'rejected', code: 'invalid_payload' };

      const questionId = row.question_id as string;
      const status = row.question_status as QuestionStatus;
      const eventId = submission.eventId || null;
      const now = Date.now();
      if (eventId !== null) {
        const key = [submission.channel, submission.accountId, eventId] as const;
        const event = this.db.prepare(`
          SELECT delivery_id FROM submission_events WHERE channel=? AND account_id=? AND event_id=?
        `).get(...key);
        if (event) return event.delivery_id === deliveryId ? { kind: 'duplicate', status } :
          { kind: 'rejected', code: 'event_mismatch' };
        this.db.prepare(`
          INSERT INTO submission_events (channel, account_id, event_id, delivery_id, created_at) VALUES (?, ?, ?, ?, ?)
        `).run(...key, deliveryId, now);
      }
      if (status !== 'pending' && status !== 'failed') return { kind: 'duplicate', status };
      // A definite failure did not deliver an answer. Without a platform event ID,
      // an old failed hash must not permanently prevent retrying that same answer.
      if (eventId === null && this.db.prepare(`
        SELECT 1 FROM submissions WHERE question_id=? AND answer_hash=? AND phase <> 'failed'
      `).get(questionId, answerHash)) return { kind: 'duplicate', status };

      const attemptId = randomUUID();
      this.db.prepare(`
        INSERT INTO submissions (id, question_id, delivery_id, event_id, operator_id, answer_hash, answers_json,
          payload_json, bridge_request_id, client_user_message_id, phase, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(attemptId, questionId, deliveryId, eventId, submission.operatorId, answerHash, JSON.stringify(answers),
        JSON.stringify(payload), randomUUID(), payload.kind === 'native' ? null : randomUUID(), now, now);
      this.db.prepare("UPDATE questions SET status='submitting', version=version+1, code=NULL, updated_at=? WHERE id=?")
        .run(now, questionId);
      return { kind: 'accepted', attemptId };
    });
  }

  getAttempt(id: string): Attempt | null {
    const row = this.db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
    return row ? readAttempt(row) : null;
  }

  listAttempts(): Attempt[] {
    return this.db.prepare('SELECT * FROM submissions ORDER BY sequence').all().map(readAttempt);
  }

  listUncertainAttempts(): Attempt[] {
    return this.db.prepare("SELECT * FROM submissions WHERE phase='unknown' ORDER BY sequence").all().map(readAttempt);
  }

  beginDispatch(id: string, route?: AsyncRoute): boolean {
    return this.db.prepare("UPDATE submissions SET phase='dispatching', async_route=?, updated_at=? WHERE id=? AND phase='queued'")
      .run(route ?? null, Date.now(), id).changes === 1;
  }

  saveAsyncMapping(id: string, mapping: AsyncMessageMapping): void {
    this.transaction(() => {
      const current = this.getAttempt(id);
      if (current?.asyncRoute !== 'steer' || !['awaiting_receipt', 'unknown'].includes(current.phase)) return;
      const saved = current.asyncMapping;
      if (saved?.serverUserMessageId && mapping.serverUserMessageId && saved.serverUserMessageId !== mapping.serverUserMessageId ||
          saved?.serverClientUserMessageId && mapping.serverClientUserMessageId &&
          saved.serverClientUserMessageId !== mapping.serverClientUserMessageId)
        throw new Error('Conflicting async receipt mapping.');
      this.db.prepare('UPDATE submissions SET async_mapping_json=?, updated_at=? WHERE id=?')
        .run(JSON.stringify({ ...saved, ...mapping }), Date.now(), id);
    });
  }

  markAwaitingReceipt(id: string, returnedTurnId: string | null): void {
    this.db.prepare(`
      UPDATE submissions SET phase='awaiting_receipt', returned_turn_id=?, updated_at=? WHERE id=? AND phase='dispatching'
    `).run(returnedTurnId, Date.now(), id);
  }

  markFailed(id: string, code: string): void {
    this.finishAttempt(id, ['queued', 'dispatching'], 'failed', code, null);
  }

  markUnknown(id: string, code: string): void {
    this.finishAttempt(id, ['dispatching', 'awaiting_receipt'], 'unknown', code, null);
  }

  markAnswered(id: string, receipt: Receipt): void {
    this.finishAttempt(id, ['awaiting_receipt', 'unknown'], 'answered', null, receipt);
  }

  private finishAttempt(id: string, from: AttemptPhase[], phase: 'failed' | 'unknown' | 'answered',
    code: string | null, receipt: Receipt | null): void {
    this.transaction(() => {
      const current = this.getAttempt(id);
      if (!current || !from.includes(current.phase)) return;
      if (phase === 'answered') {
        const record = this.getQuestion(current.questionId);
        if (!record || !receipt || !receiptMatches(record.question, current, receipt)) return;
      }
      const now = Date.now();
      this.db.prepare(`UPDATE submissions SET phase=?, receipt_json=?, code=?, updated_at=?,
        returned_turn_id=COALESCE(returned_turn_id, ?) WHERE id=?`)
        .run(phase, receipt ? JSON.stringify(receipt) : null, code, now, receipt?.kind === 'async' ? receipt.turnId : null, id);
      this.db.prepare('UPDATE questions SET status=?, version=version+1, code=?, updated_at=? WHERE id=?')
        .run(phase, code, now, current.questionId);
    });
  }

  recover(): { queued: Attempt[]; uncertain: Attempt[] } {
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare(`
        UPDATE deliveries SET state='unknown', code='interrupted_delivery', updated_at=? WHERE state='sending'
      `).run(now);
      this.db.prepare(`
        UPDATE questions SET status='unknown', version=version+1, code='interrupted_dispatch', updated_at=?
        WHERE id IN (SELECT question_id FROM submissions WHERE phase IN ('dispatching', 'awaiting_receipt'))
      `).run(now);
      this.db.prepare(`
        UPDATE submissions SET phase='unknown', code='interrupted_dispatch', updated_at=?
        WHERE phase IN ('dispatching', 'awaiting_receipt')
      `).run(now);
      return {
        queued: this.db.prepare("SELECT * FROM submissions WHERE phase='queued' ORDER BY sequence").all().map(readAttempt),
        uncertain: this.listUncertainAttempts(),
      };
    });
  }
}

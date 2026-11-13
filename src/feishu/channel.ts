import type { ChannelSubmission, Delivery, MessageRef, NotificationChannel, Question, QuestionView, Route, SubmissionAck } from '../questions/model.js';
import { decodeAnswers, object, renderQuestionCard, statusText, validDeliveryToken } from './cards.js';
import { isMessageId, sdkTransport, type FeishuConfig, type FeishuToast, type FeishuTransport } from './transport.js';

export type { FeishuConfig, FeishuConnectionState, FeishuTargetType, FeishuTransport } from './transport.js';

export type FeishuDeliveryLookup = (reference: { token: string } | { messageId: string }) =>
  { delivery: Delivery; question: Question; project?: string } | null;

const openId = /^ou_[A-Za-z0-9]{1,128}$/;
const chatId = /^oc_[A-Za-z0-9]{1,128}$/;
const eventIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

function toast(content: string, type: 'info' | 'error' = 'info'): FeishuToast { return { toast: { type, content } }; }

function sameRoute(a: Route, b: Route): boolean {
  return a.channel === b.channel && a.accountId === b.accountId && a.targetId === b.targetId;
}

function ackToast(ack: SubmissionAck): FeishuToast {
  if (ack.kind === 'accepted') return toast(statusText('submitting'));
  if (ack.kind === 'duplicate') return toast(statusText(ack.status));
  switch (ack.code) {
    case 'invalid_answers': return toast('请完整填写每道必答题，每题只提交一个答案。', 'error');
    case 'unauthorized': return toast('此操作仅限已配置的用户。', 'error');
    case 'session_disabled': return toast('此聊天已停止接收答案，请在 Codex 桌面端回答。', 'error');
    case 'unavailable': return toast('当前无法提交，请稍后重试或在 Codex 桌面端回答。', 'error');
    default: return toast('卡片与原问题不匹配，请在 Codex 桌面端核对。', 'error');
  }
}

export class FeishuChannel implements NotificationChannel {
  readonly route: Route;
  private readonly operators: Set<string>;
  private readonly targetType: FeishuConfig['targetType'];
  private readonly transport: FeishuTransport;
  private submit?: (submission: ChannelSubmission) => Promise<SubmissionAck>;

  constructor(config: FeishuConfig, private readonly lookup: FeishuDeliveryLookup, transport?: FeishuTransport) {
    const { appId, appSecret, targetId, targetType, allowedOperatorIds } = config;
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret.trim() ||
        !((targetType === 'open_id' && openId.test(targetId)) || (targetType === 'chat_id' && chatId.test(targetId))) ||
        !allowedOperatorIds.length || allowedOperatorIds.some(operator => !openId.test(operator))) {
      throw new Error('Invalid Feishu app, target or operator configuration.');
    }
    this.route = Object.freeze({ channel: 'feishu', accountId: appId, targetId });
    this.targetType = targetType;
    this.operators = new Set(allowedOperatorIds);
    this.transport = transport ?? sdkTransport({ ...config });
  }

  async start(onSubmit: (submission: ChannelSubmission) => Promise<SubmissionAck>): Promise<void> {
    if (this.submit) throw new Error('Feishu channel is already active.');
    this.submit = onSubmit;
    try { await this.transport.start(data => this.onAction(data)); }
    catch (error) { this.submit = undefined; throw error; }
  }

  async stop(): Promise<void> {
    this.submit = undefined;
    await this.transport.stop();
  }

  async sendQuestion(question: Question, token: string, deliveryKey: string): Promise<MessageRef> {
    const stored = this.lookup({ token });
    const project = stored?.question.id === question.id ? stored.project : undefined;
    const messageId = await this.transport.create(renderQuestionCard(question, token, 'pending', project), deliveryKey);
    if (!isMessageId(messageId)) throw new Error('Feishu notification outcome is unconfirmed.');
    return { ...this.route, messageId };
  }

  async updateQuestion(ref: MessageRef, view: QuestionView): Promise<void> {
    if (!sameRoute(ref, this.route) || !isMessageId(ref.messageId)) throw new Error('Feishu message route does not match.');
    const stored = this.lookup({ messageId: ref.messageId });
    if (!stored || stored.delivery.state !== 'sent' || !sameRoute(stored.delivery.route, ref) ||
        stored.delivery.message?.messageId !== ref.messageId || stored.question.id !== stored.delivery.questionId) {
      throw new Error('Feishu message is not associated with a local question.');
    }
    await this.transport.patch(ref.messageId, renderQuestionCard(stored.question, stored.delivery.token, view.status, stored.project));
  }

  private async onAction(data: unknown): Promise<FeishuToast> {
    if (!this.submit) return ackToast({ kind: 'rejected', code: 'unavailable' });
    try {
      // SDK 1.76 flattens the v2 header and event. Accept the envelope as
      // well so fixtures can describe the real platform's payload verbatim.
      if (!object(data)) return ackToast({ kind: 'rejected', code: 'invalid_delivery' });
      const meta = object(data.header) ? data.header : data;
      const event = object(data.event) ? data.event : data;
      if ((meta.app_id !== undefined && meta.app_id !== this.route.accountId) ||
          (meta.event_type !== undefined && meta.event_type !== 'card.action.trigger')) {
        return ackToast({ kind: 'rejected', code: 'invalid_delivery' });
      }
      const operatorId = object(event.operator) ? event.operator.open_id : null;
      if (typeof operatorId !== 'string' || !this.operators.has(operatorId)) {
        return ackToast({ kind: 'rejected', code: 'unauthorized' });
      }
      const context = event.context;
      const action = event.action;
      if (!object(context) || !isMessageId(context.open_message_id) ||
          (this.targetType === 'chat_id' && context.open_chat_id !== this.route.targetId) ||
          !object(action) || action.tag !== 'button' || !object(action.value) || action.value.action !== 'answer' ||
          !validDeliveryToken(action.value.token)) {
        return ackToast({ kind: 'rejected', code: 'invalid_delivery' });
      }
      const token = action.value.token;
      const eventId = meta.event_id;
      if (eventId !== undefined && (typeof eventId !== 'string' || !eventIdPattern.test(eventId))) {
        return ackToast({ kind: 'rejected', code: 'invalid_delivery' });
      }
      const stored = this.lookup({ token });
      if (!stored || stored.delivery.token !== token || stored.delivery.state !== 'sent' ||
          !sameRoute(stored.delivery.route, this.route) || stored.delivery.message?.messageId !== context.open_message_id ||
          stored.question.id !== stored.delivery.questionId) {
        return ackToast({ kind: 'rejected', code: 'invalid_delivery' });
      }
      const answers = object(action.form_value) ? decodeAnswers(stored.question, token, action.form_value, stored.project) : null;
      if (!answers) return ackToast({ kind: 'rejected', code: 'invalid_answers' });
      // The core's acknowledgement follows the SQLite commit. Do not wait
      // for a Codex receipt or patch a card from the callback response.
      const ack = await this.submit({ channel: this.route.channel, accountId: this.route.accountId,
        operatorId, messageId: context.open_message_id, token, answers,
        ...(eventId === undefined ? {} : { eventId }) });
      return ackToast(ack);
    } catch {
      return toast('提交结果待确认，请在 Codex 桌面端核对。', 'error');
    }
  }
}

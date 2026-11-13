import type { AnswerMap, Question, QuestionField, QuestionStatus } from '../questions/model.js';

export const MAX_ANSWER_LENGTH = 500;
const CARD_BUDGET = 24 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function validDeliveryToken(value: unknown): value is string {
  return typeof value === 'string' && tokenPattern.test(value);
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plain(content: string) { return { tag: 'plain_text', content }; }
function div(content: string) { return { tag: 'div', text: plain(content) }; }

const statuses: Record<QuestionStatus, string> = {
  pending: '待回答',
  submitting: '提交中 · 正在等待 Codex 接收答案',
  answered: '已回答 · Codex 已接收答案',
  failed: '提交失败 · 答案未送达；请在桌面确认原问题仍待回答后重试',
  unknown: '结果待确认 · 请到 Codex 桌面端核对',
};

export function statusText(status: QuestionStatus): string { return statuses[status]; }

function card(title: string, elements: unknown[]): string {
  return JSON.stringify({ schema: '2.0', header: { title: plain(title) }, body: { elements } });
}

function textField(name: string, required: boolean, placeholder: string) {
  return { tag: 'input', name, required, max_length: MAX_ANSWER_LENGTH, placeholder: plain(placeholder) };
}

function fieldLayout(field: QuestionField, index: number) {
  const options = field.options ?? [];
  return { field, options, choice: `q_${index}_choice`, input: `q_${index}_text` };
}

function renderForm(question: Question, token: string) {
  // Keep the form within the layout used by the verified Feishu card. Larger
  // requests get an explicit desktop-only card; no partial form is sent.
  if (question.desktopOnly ||
      !validDeliveryToken(token) || question.fields.length < 1 || question.fields.length > 5) return null;
  const elements: unknown[] = [];
  for (const { field, options, choice, input } of question.fields.map(fieldLayout)) {
    if (field.text.length > 500 || options.length > 10 || options.some(option => option.label.length > 80)) return null;
    elements.push(div(field.text));
    if (!options.length) {
      elements.push(textField(input, field.required, '填写答案'));
      continue;
    }
    const descriptions = options.filter(option => option.description?.trim())
      .map(option => `${option.label}：${option.description}`).join('\n');
    if (descriptions.length > 1000) return null;
    if (descriptions) elements.push(div(descriptions));
    const entries = options.map((option, i) => ({ text: plain(option.label), value: `option_${i}` }));
    if (field.allowOther) entries.push({ text: plain('其他（填写下方文字）'), value: 'other' });
    elements.push({ tag: 'select_static', name: choice, required: field.required,
      placeholder: plain('选择一个选项'), options: entries });
    if (field.allowOther) elements.push(textField(input, false, '选择「其他」后填写'));
  }
  elements.push({ tag: 'button', name: 'answer_submit', text: plain('提交答案'), type: 'primary',
    form_action_type: 'submit', behaviors: [{ type: 'callback', value: { token, action: 'answer' } }] });
  return { tag: 'form', name: 'codex_questions', elements };
}

function renderCard(question: Question, token: string, status: QuestionStatus, project?: string) {
  const title = 'Codex 问答';
  const threadId = question.session.threadId;
  const chat = question.taskTitle.trim() || [project || '聊天', threadId.slice(0, 8)].join(' · ');
  const compact = (text: string) => text.length > 240 ? `${text.slice(0, 237)}…` : text;
  const context = [div(`聊天：${compact(chat)}`), ...(project ? [div(`项目：${compact(project)}`)] : []),
    div(`桌面链接：codex://threads/${threadId}`), div(statusText(status))];
  const needsForm = status === 'pending' || status === 'failed';
  if (!needsForm) return { answerable: false, content: card(title, context) };
  const form = renderForm(question, token);
  if (form) {
    // Native question text is already present in each input section.
    const prompt = question.kind === 'plain' && !question.fields.some(field => field.text === question.prompt)
      ? [div(question.prompt)] : [];
    const content = card(title, [...context, ...prompt, form]);
    if (Buffer.byteLength(content) <= CARD_BUDGET) return { answerable: true, content };
  }
  const instruction = div('请在 Codex 桌面端回答这个问题。');
  if (question.kind === 'plain' || question.desktopOnly) {
    const full = card(title, [...context, div(question.prompt), instruction]);
    if (Buffer.byteLength(full) <= CARD_BUDGET) return { answerable: false, content: full };
  }
  return { answerable: false, content: card(title, [...context,
    question.kind === 'plain' || question.desktopOnly ? instruction : div('这个问题超出卡片表单的范围，请在 Codex 桌面端回答。')]) };
}

export function renderQuestionCard(question: Question, token: string, status: QuestionStatus, project?: string): string {
  return renderCard(question, token, status, project).content;
}

export function decodeAnswers(question: Question, token: string, form: Record<string, unknown>, project?: string): AnswerMap | null {
  // Match the frozen card's capacity checks even after a restart. A callback
  // for a desktop-only card cannot supply synthetic form fields.
  if (!renderCard(question, token, 'pending', project).answerable) return null;
  const layout = question.fields.map(fieldLayout);
  const knownKeys = new Set(layout.flatMap(({ field, options, choice, input }) =>
    !options.length ? [input] : field.allowOther ? [choice, input] : [choice]));
  if (Object.keys(form).some(key => !knownKeys.has(key))) return null;
  const entries: [string, { answers: string[] }][] = [];
  for (const { field, options, choice, input } of layout) {
    const selected = Object.hasOwn(form, choice) ? form[choice] : undefined;
    const custom = Object.hasOwn(form, input) ? form[input] : undefined;
    if (custom !== undefined && custom !== null && typeof custom !== 'string') return null;
    const hasText = typeof custom === 'string' && !!custom.trim();
    const hasChoice = selected !== undefined && selected !== null && selected !== '';
    if (!hasChoice && !hasText && !field.required) continue;
    let answer: string;
    if (!options.length || (field.allowOther && selected === 'other')) {
      if (typeof custom !== 'string' || !hasText || custom.length > MAX_ANSWER_LENGTH) return null;
      answer = custom;
    } else {
      if (hasText || typeof selected !== 'string' || !/^option_[0-9]$/.test(selected)) return null;
      const option = options[Number(selected.slice(7))];
      if (!option) return null;
      answer = option.label;
    }
    entries.push([field.id, { answers: [answer] }]);
  }
  return Object.fromEntries(entries);
}

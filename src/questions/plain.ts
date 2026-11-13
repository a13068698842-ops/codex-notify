import { readFileSync } from 'node:fs';
import type { QuestionField } from './model.js';

export type QuestionRules = ReadonlyArray<{ id: string; pattern: RegExp }>;
export type PlainDetection = { ruleId: string; prompt: string } & (
  | { kind: 'question'; fields: QuestionField[] }
  | { kind: 'desktop_only' }
);

/** Read once at startup. The default is next to package.json, outside the compiled code. */
export function loadQuestionRules(path?: string): QuestionRules {
  const value: unknown = JSON.parse(readFileSync(path ?? new URL('../../../question-rules.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  if (value === null || typeof value !== 'object' || !('rules' in value) || !Array.isArray(value.rules) ||
      value.rules.length === 0 || value.rules.length > 64) throw new Error('Invalid ordinary question rules.');
  const ids = new Set<string>();
  return value.rules.map((rule: unknown) => {
    if (rule === null || typeof rule !== 'object' || !('id' in rule) || !('pattern' in rule) ||
        typeof rule.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(rule.id) || ids.has(rule.id) ||
        typeof rule.pattern !== 'string' || !rule.pattern.trim() || rule.pattern.length > 1024)
      throw new Error('Invalid ordinary question rule.');
    ids.add(rule.id);
    let pattern: RegExp;
    try { pattern = new RegExp(rule.pattern, 'iu'); } catch { throw new Error(`Invalid ordinary question rule: ${rule.id}.`); }
    if (pattern.test('')) throw new Error(`Ordinary question rule matches empty text: ${rule.id}.`);
    return { id: rule.id, pattern };
  });
}

type Line = { raw: string; visible: string; index: number; indent: number; marker?: Marker };
type Marker = { type: 'number' | 'letter'; order: number; value: string } | { type: 'layout'; value: string };

function visibleText(value: string): string {
  return value
    // Mask inline code, links and bare URLs; punctuation inside them is not a question signal.
    .replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, ' ')
    .replace(/!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]/g, ' ')
    .replace(/<https?:[^>]+>|https?:\/\/[^\s<>]+/gi, ' ')
    .replace(/\\[?？]/gu, ' ')
    .replace(/\*\*|__/g, '')
    .trim();
}

function markerFor(text: string): Marker | undefined {
  // Support common Markdown list markers, including emphasis on a letter marker.
  const lead = /^(?:[-*+]\s+)?(?:\*\*|__)?(?:([A-Z\d]+)([.)、）．:：])|[（(]([A-Z\d]+)[）)])(?:\*\*|__)?/u.exec(text);
  if (lead) {
    const key = lead[1] ?? lead[3];
    const rest = text.slice(lead[0].length);
    // A dot without spacing can be a decimal point or part of an identifier.
    if (/^(?:\s|[^\x00-\x7F])|^$/u.test(rest) || lead[2] !== '.') {
      const value = rest.trim();
      if (value && /^\d{1,3}$/.test(key) && !/[:：]/u.test(lead[2] ?? ''))
        return { type: 'number', order: Number(key), value };
      if (value && /^[A-Z]$/.test(key)) return { type: 'letter', order: key.charCodeAt(0) - 64, value };
      if (value) return { type: 'layout', value };
    }
  }
  const letter = /^(?:[-*+]\s+)?(?:\*\*|__)?([A-Z])(?:\*\*|__)?(?:\s*[:：]|\s+[-–—])\s*(\S.*)$/u.exec(text);
  if (letter) return { type: 'letter', order: letter[1].charCodeAt(0) - 64, value: letter[2] };
  if (/^(?:[-*+•・]\s+|\||[-*+]\s*\[[ xX]\])/u.test(text)) return { type: 'layout', value: text };
  return undefined;
}

function textLines(text: string): { source: string[]; lines: Line[] } {
  const source = text.split(/\r\n?|\n/u);
  const lines: Line[] = [];
  let fence: string | undefined;
  let listIndent: number | undefined;
  for (const [index, original] of source.entries()) {
    const raw = original.trim();
    if (/^>/u.test(raw)) continue;
    const delimit = /^(?:[-*+]\s+)?(`{3,}|~{3,})(.*)$/u.exec(raw);
    if (fence) {
      if (delimit && delimit[1][0] === fence[0] && delimit[1].length >= fence.length && !delimit[2].trim()) fence = undefined;
      continue;
    }
    if (delimit) { fence = delimit[1]; continue; }
    const indent = original.match(/^\s*/u)![0].replace(/\t/g, '    ').length;
    // Four leading spaces form a Markdown code block unless the line is nested under a list.
    if (indent >= 4 && (listIndent === undefined || indent <= listIndent)) continue;
    let marker = markerFor(raw);
    const separator = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u;
    const previous = lines.at(-1);
    if (!marker && raw.includes('|') && (
      separator.test(source[index + 1]?.trim() ?? '') || separator.test(raw) ||
      previous?.marker?.type === 'layout' && previous.raw.includes('|') && previous.index === index - 1
    )) marker = { type: 'layout', value: raw };
    if (raw && indent < 4) listIndent = marker ? indent : undefined;
    const visible = visibleText(marker?.value ?? raw);
    if (visible || marker) lines.push({ raw, visible, index, indent, marker });
  }
  return { source, lines };
}

const optionLabel = /^(?:options?|choices?|选项(?:如下)?|备选(?:项)?)\s*[:：]$/iu;
const questionLabel = /^(?:questions?|问题(?:如下)?|请回答(?:下列|以下)(?:问题)?|(?:please\s+)?answer\s+(?:these|the following)(?:\s+questions)?)\s*[:：]$/iu;
const heading = /^#{1,6}\s/u;
const inlineMarker = String.raw`(?:[A-Z0-9]\.(?:\s+|(?=[^\x00-\x7F]))|\(?[A-Z0-9][)、）．]\s*|[（(][A-Z0-9][）)]\s*|[A-Z][:：]\s*)`;
const inlineOptions = new RegExp(String.raw`(?:^|[\s：:，,])${inlineMarker}\S.*?(?:[\s，,；;]|\))${inlineMarker}\S`, 'u');
const questionsIn = (value: string) => value.match(/[?？]+/gu)?.length ?? 0;

export function detectPlainQuestion(text: string, rules: QuestionRules): PlainDetection | null {
  const { source, lines } = textLines(text);
  const last = lines.at(-1);
  if (!last) return null;
  const ruleFor = (line: Line | undefined) => line?.visible && !heading.test(line.visible)
    ? rules.find(rule => rule.pattern.test(line.visible))?.id : undefined;
  const complex = (ruleId: string): PlainDetection => ({ kind: 'desktop_only', ruleId, prompt: text });
  // Masked blocks do not trigger a question, but may contain its choices or
  // constraints. Never discard such trailing content from an answerable form.
  const trailingContent = source.slice(last.index + 1).some(line => line.trim());
  const fragment = (start: Line, end: Line) => source.slice(start.index, end.index + 1).join('\n').trim();
  const field = (index: number, fieldText: string): QuestionField => ({
    id: `q${index + 1}`, text: fieldText, allowOther: false, required: true,
  });
  const plainStart = (end: number): number => {
    let start = end;
    while (start > 0) {
      const previous = lines[start - 1];
      if (lines[start].index !== previous.index + 1 || previous.marker || heading.test(previous.raw) ||
          questionLabel.test(previous.visible) || optionLabel.test(previous.visible)) break;
      start--;
    }
    return start;
  };
  const visibleIndices = new Set(lines.map(line => line.index));
  const hasGap = (start: Line, end: Line) => source.slice(start.index, end.index + 1)
    .some((raw, index) => raw.trim() && !visibleIndices.has(start.index + index));
  const mixedQuestion = (line: Line) => questionsIn(line.visible) > 1 || inlineOptions.test(line.visible);
  const listStart = (end: number) => {
    let start = end;
    while (start > 0 && lines[start - 1].marker) start--;
    return start;
  };
  const nearbyQuestion = (start: number) => {
    const previous = lines[start - 1];
    const stem = lines[start - 2];
    return optionLabel.test(previous?.visible ?? '') || questionLabel.test(previous?.visible ?? '')
      ? ruleFor(stem) : ruleFor(previous);
  };

  if (last.marker) {
    const start = listStart(lines.length - 1);
    const rows = lines.slice(start);
    const label = lines[start - 1];
    const introIndex = start - (label && optionLabel.test(label.visible) ? 2 : 1);
    const intro = lines[introIndex];
    const introRule = ruleFor(intro);
    const rowRules = rows.map(ruleFor);
    const ruleId = introRule ?? rowRules.find(Boolean);
    if (!ruleId) return null;
    if (trailingContent) return complex(ruleId);
    const shape = rows[0].marker?.type;
    const ordered = rows.every((row, index) =>
      row.marker && row.marker.type === shape && row.marker.type !== 'layout' &&
      row.marker.order === index + 1 && row.indent === rows[0].indent);

    if (shape === 'number' && ordered && rowRules.every(Boolean) &&
        !nearbyQuestion(start) && rows.every(row => !mixedQuestion(row)) &&
        !hasGap(rows[0], last) && !optionLabel.test(label?.visible ?? '')) {
      const first = label && questionLabel.test(label.visible) ? label : rows[0];
      return { kind: 'question', ruleId, prompt: fragment(first, last), fields: rows.map((row, i) => field(i, row.raw)) };
    }
    if (introRule && intro && !questionLabel.test(intro.visible) && rows.length >= 2 && ordered && rowRules.every(id => !id) &&
        !mixedQuestion(intro) && rows.every(row => !!row.visible && !mixedQuestion(row)) && !hasGap(intro, last)) {
      const firstIndex = plainStart(introIndex);
      if (ruleFor(lines[firstIndex - 1]) ||
          lines.slice(firstIndex, introIndex).some(line => ruleFor(line) || questionsIn(line.visible))) return complex(ruleId);
      const options = rows.map(row => ({ label: row.marker!.value }));
      if (new Set(options.map(option => option.label)).size !== options.length) return complex(ruleId);
      return { kind: 'question', ruleId, prompt: fragment(lines[firstIndex], last),
        fields: [{ ...field(0, fragment(lines[firstIndex], intro)), options }] };
    }
    return complex(ruleId);
  }

  const ruleId = ruleFor(last);
  const first = plainStart(lines.length - 1);
  const previous = lines[first - 1];
  const precedingListRule = previous?.marker ? (
    nearbyQuestion(listStart(first - 1)) ?? lines.slice(listStart(first - 1), first).map(ruleFor).find(Boolean)
  ) : undefined;
  if (!ruleId) {
    // A continuation can be part of an option. Do not return a partial form.
    if (previous?.marker && lines[first].index === previous.index + 1 && precedingListRule) return complex(precedingListRule);
    const mark = /[?？]/u.exec(last.visible);
    if (!mark || !inlineOptions.test(last.visible)) return null;
    const rule = rules.find(entry => entry.pattern.test(last.visible.slice(0, mark.index + mark[0].length)));
    return rule ? complex(rule.id) : null;
  }
  if (trailingContent || mixedQuestion(last) || questionLabel.test(last.visible) || optionLabel.test(last.visible)) return complex(ruleId);
  if (ruleFor(previous) || lines.slice(first, -1).some(line => ruleFor(line) || questionsIn(line.visible))) return complex(ruleId);
  // A final instruction following a question list must not hide that list or its stem.
  if (precedingListRule) return complex(ruleId);
  const prompt = fragment(lines[first], last);
  return { kind: 'question', ruleId, prompt, fields: [field(0, prompt)] };
}

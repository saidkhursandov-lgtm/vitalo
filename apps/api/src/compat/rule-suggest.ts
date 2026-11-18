/**
 * D-78: a substance just added to the dictionary has no compatibility rules, so «Идеальная пара» and the compatibility
 * check know nothing about it. The model proposes a few well-known rules (synergy / spread / avoid) between it and the
 * dictionary; they are saved as drafts (origin «vitalo») and work only after an admin approves them (D-45).
 * No database or network access here.
 */
import { MEALS, TIMES, joinWhen, type Meal, type TimeOfDay } from './knowledge';

export const SUGGEST_KINDS = ['synergy', 'spread', 'avoid'] as const;
export type SuggestKind = (typeof SUGGEST_KINDS)[number];
export const SUGGEST_MAX = 6;

export const RULES_SYSTEM = `Ты — фармацевт магазина БАДов VITALO. В справочник добавлено новое вещество. Предложи до ${SUGGEST_MAX}
правил совместимости между ним (сторона A) и веществами справочника (сторона B):
- synergy — вместе работают лучше (например, витамин D3 и K2, железо и витамин C);
- spread — лучше принимать в разное время, interval_hours — через сколько часов (например, кальций и железо — 4);
- avoid — вместе не принимать.
Только правила, которые хорошо известны по исследованиям или официальным рекомендациям; если не уверен — не предлагай.
Не повторяй пары из списка «уже есть». code — ТОЛЬКО коды из справочника.
time_a/time_b — лучшее время приёма (morning, day, evening, any) или null; meal_a/meal_b — with_food, with_fat,
empty_stomach, any или null.
text_ru — одно-два коротких предложения для покупателя, спокойно, без обещаний лечения; text_uz — то же по-узбекски
латиницей. source — откуда это известно, коротко (например «рекомендации ВОЗ», «обзор исследований»).
Отвечай строго по схеме JSON.`;

const sn = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const en = (values: readonly string[]) => ({ anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }] });

export const RULES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'kind', 'interval_hours', 'time_a', 'meal_a', 'time_b', 'meal_b', 'text_ru', 'text_uz', 'source'],
        properties: {
          code: { type: 'string' },
          kind: { type: 'string', enum: [...SUGGEST_KINDS] },
          interval_hours: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          time_a: en(TIMES),
          meal_a: en(MEALS),
          time_b: en(TIMES),
          meal_b: en(MEALS),
          text_ru: { type: 'string' },
          text_uz: { type: 'string' },
          source: sn,
        },
      },
    },
  },
} as const;

export interface RuleDictEntry {
  id: string;
  code: string;
  name_ru: string;
  synonyms: string[];
  enabled: boolean;
  kind: string;
}

export function rulesDataBlock(target: RuleDictEntry, dict: RuleDictEntry[], existingPairs: Set<string>, examples: string[]): string {
  const others = dict.filter((d) => d.id !== target.id && d.enabled && d.kind !== 'drug_group');
  return [
    `Новое вещество (A): ${target.code} | ${target.name_ru}${target.synonyms.length ? ` | ${target.synonyms.slice(0, 6).join(', ')}` : ''}`,
    '',
    `Уже есть правила с: ${[...existingPairs].map((id) => dict.find((d) => d.id === id)?.code).filter(Boolean).join(', ') || 'нет'}`,
    '',
    examples.length ? `Примеры текстов утверждённых правил:\n${examples.map((e) => `- ${e}`).join('\n')}\n` : '',
    '<справочник>',
    ...others.map((d) => `- ${d.code} | ${d.name_ru}`),
    '</справочник>',
  ].join('\n');
}

export interface SuggestedRule {
  substance_b_id: string;
  kind: SuggestKind;
  interval_hours: number | null;
  time_a: TimeOfDay | null;
  meal_a: Meal | null;
  time_b: TimeOfDay | null;
  meal_b: Meal | null;
  when_a: string | null;
  when_b: string | null;
  text_ru: string;
  text_uz: string;
  source: string | null;
}

const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => ((list as readonly unknown[]).includes(v) ? (v as T) : null);
const CYRILLIC = /[А-Яа-яЁё]/;

/** The answer → rules to save: known codes only, not the substance itself, no pair that already has a rule, texts present. */
export function checkRulesAnswer(json: unknown, target: RuleDictEntry, dict: RuleDictEntry[], existingPairs: Set<string>): { ok: true; value: SuggestedRule[] } | { ok: false; error: string } {
  if (!json || typeof json !== 'object' || !Array.isArray((json as Record<string, unknown>).rules)) return { ok: false, error: 'shape' };
  const byCode = new Map(dict.filter((d) => d.enabled && d.kind !== 'drug_group').map((d) => [d.code, d]));
  const seen = new Set(existingPairs);
  const out: SuggestedRule[] = [];
  for (const r of (json as { rules: Record<string, unknown>[] }).rules) {
    const b = typeof r?.code === 'string' ? byCode.get(r.code.trim()) : undefined;
    const kind = oneOf(r?.kind, SUGGEST_KINDS);
    const text_ru = typeof r?.text_ru === 'string' ? r.text_ru.trim().slice(0, 500) : '';
    const text_uz = typeof r?.text_uz === 'string' ? r.text_uz.trim().slice(0, 500) : '';
    if (!b || b.id === target.id || seen.has(b.id) || !kind || text_ru.length < 5 || text_uz.length < 5 || CYRILLIC.test(text_uz)) continue;
    seen.add(b.id);
    const time_a = oneOf(r.time_a, TIMES);
    const meal_a = oneOf(r.meal_a, MEALS);
    const time_b = oneOf(r.time_b, TIMES);
    const meal_b = oneOf(r.meal_b, MEALS);
    const interval = typeof r.interval_hours === 'number' && Number.isInteger(r.interval_hours) && r.interval_hours >= 1 && r.interval_hours <= 24 ? r.interval_hours : null;
    out.push({
      substance_b_id: b.id,
      kind,
      interval_hours: kind === 'spread' ? (interval ?? 2) : null,
      time_a,
      meal_a,
      time_b,
      meal_b,
      when_a: joinWhen(time_a, meal_a),
      when_b: joinWhen(time_b, meal_b),
      text_ru,
      text_uz,
      source: typeof r.source === 'string' && r.source.trim() ? r.source.trim().slice(0, 300) : null,
    });
    if (out.length >= SUGGEST_MAX) break;
  }
  return { ok: true, value: out };
}

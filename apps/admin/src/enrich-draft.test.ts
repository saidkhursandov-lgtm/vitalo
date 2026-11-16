import { describe, expect, it } from 'vitest';
import { mergeDraft } from './components/EnrichDraft';

const sub = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  code: id,
  kind: 'substance',
  name_ru: name,
  name_uz: name,
  parent_name: null,
  dose_amount: null,
  dose_unit: null,
  in_label: false,
  ...extra,
});

describe('«Принять» черновик AI (как mergeEnrichment в API)', () => {
  it('общее вещество из черновика при форме в карточке: форма остаётся и получает дозу, «Омега-3» не добавляется', () => {
    const parentOf = new Map<string, string | null>([['o3', null], ['o3r', 'o3']]);
    const current = [{ ...sub('o3r', 'Омега-3 rTG', { kind: 'form', parent_name: 'Омега-3' }), in_label: true }];
    const merged = mergeDraft(
      current,
      { substances: [sub('o3', 'Омега-3', { dose_amount: 1280, dose_unit: 'mg', in_label: true })], unknown: [], audience: 'adult', goals: [], note: '' },
      parentOf,
    );
    expect(merged.map((m) => [m.id, m.name_ru, m.in_label, m.dose_amount])).toEqual([['o3r', 'Омега-3 rTG', true, 1280]]);
  });
});

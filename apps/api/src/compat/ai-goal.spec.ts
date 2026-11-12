import { DOCTOR_LINE, GOALS, KINDS, LEVEL_LABELS, bestLevel, checkGoalAnswer, findGoalForbidden, goalDataBlock, isKind, type GoalData } from './ai-goal';

const data = (over: Partial<GoalData> = {}): GoalData => ({
  lang: 'ru',
  goal: 'sleep',
  duration: '2to4w',
  kind: 'fall_asleep',
  cart: [
    { ref: 'VTL-1', name: 'Магний B6', substances: ['Магний', 'Витамин B6'], form: 'цитрат', evidence: [{ substance: 'Магний', level: 'B', helps: 'при напряжении и дефиците магния', not_helps: 'если мешают кофеин и гаджеты' }] },
    { ref: 'VTL-2', name: 'Витамин D3', substances: ['Витамин D3'], form: null, evidence: [] },
  ],
  ...over,
});
const good = {
  summary: 'Для сна в этом наборе может помочь магний; витамин D3 для этой цели можно не брать.',
  products: [
    { productId: 'VTL-1', fit: 'maybe', text: 'Магний может помочь, если сон мешает напряжение после дня.' },
    { productId: 'VTL-2', fit: 'helps', text: 'Данных немного: может помочь, если его мало в рационе.' },
  ],
  steps: ['Ложитесь в одно и то же время.', 'Уберите телефон за час до сна.'],
};

describe('Шаг 0б: «Поможет ли этот набор для моей цели?» (D-69)', () => {
  it('chips: six goals, three kinds each; a kind of another goal is refused', () => {
    expect(GOALS).toEqual(['sleep', 'stress', 'energy', 'joints', 'immunity', 'sport']);
    for (const g of GOALS) expect(KINDS[g]).toHaveLength(3);
    expect(isKind('sleep', 'fall_asleep')).toBe(true);
    expect(isKind('sleep', 'strength')).toBe(false);
  });

  it('the data block has the chips and our base, and «нет строк» when there is none', () => {
    const block = goalDataBlock(data());
    expect(block).toContain('цель: сон');
    expect(block).toContain('сколько длится: 2–4 недели');
    expect(block).toContain('что беспокоит: трудно заснуть');
    expect(block).toContain('база: Магний | уровень B | когда помогает: при напряжении и дефиците магния');
    expect(block).toContain('база для этой цели: нет строк');
  });

  it('a product with no approved row is «данных немного» whatever the model chose; the level is ours, in words', () => {
    const r = checkGoalAnswer(good, data());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.products.map((p) => p.fit)).toEqual(['maybe', 'no_data']);
    expect(bestLevel(data().cart[0].evidence)).toBe('B');
    expect(bestLevel([])).toBeNull();
    expect(LEVEL_LABELS.A).toEqual({ ru: 'Подтверждено исследованиями', uz: 'Tadqiqotlar bilan tasdiqlangan' });
    expect(LEVEL_LABELS.C.ru).toBe('Мнение специалистов');
    expect(DOCTOR_LINE.ru).toBe('Если проблема держится дольше 3–4 недель — обратитесь к врачу.');
  });

  it('every product once; steps 1–4; the language of the customer', () => {
    expect(checkGoalAnswer({ ...good, products: good.products.slice(0, 1) }, data())).toEqual({ ok: false, error: 'products' });
    expect(checkGoalAnswer({ ...good, products: [...good.products, good.products[0]] }, data())).toEqual({ ok: false, error: 'products' });
    expect(checkGoalAnswer({ ...good, steps: [] }, data())).toEqual({ ok: false, error: 'steps' });
    expect(checkGoalAnswer({ ...good, products: [{ ...good.products[0], fit: 'cure' }, good.products[1]] }, data())).toEqual({ ok: false, error: 'fit' });
    expect(checkGoalAnswer(good, data({ lang: 'uz' }))).toEqual({ ok: false, error: 'language' });
  });

  it('no diseases named, no promises, no units on the screen (D-68, D-69)', () => {
    expect(findGoalForbidden('Это может быть заболевание щитовидной железы')).toContain('заболеван');
    expect(findGoalForbidden('Возможно, у вас анемия')).toContain('анеми');
    expect(findGoalForbidden('Shifokor tashxis qoʻyadi')).toContain('tashxis');
    expect(findGoalForbidden('Принимайте 400 мг магния')).toContain('units');
    expect(findGoalForbidden('Магний гарантирует крепкий сон')).toContain('гарантир');
    expect(findGoalForbidden('Ложитесь в одно время, в режиме сна важна регулярность')).toEqual([]);
    expect(checkGoalAnswer({ ...good, summary: 'Похоже на синдром хронической усталости, магний поможет.' }, data())).toEqual({ ok: false, error: 'forbidden_words' });
  });

  it('Шаг 0в: a dose inside our product name is not a dose from the model', () => {
    const d = data({ cart: [{ ...data().cart[0], name: 'Mg + D3 + Омега-3' }, { ...data().cart[1], name: 'Biotin 5000 mkg' }] });
    const answer = { ...good, summary: 'Для сна комплекс Mg + D3 + Омега-3 может помочь; Biotin 5000 mkg для этой цели можно не брать.' };
    expect(checkGoalAnswer(answer, d).ok).toBe(true);
    expect(checkGoalAnswer({ ...answer, steps: ['Принимайте 400 мг магния.'] }, d)).toEqual({ ok: false, error: 'forbidden_words' });
    expect(findGoalForbidden('иммунный комплекс Mg + D3 можно не брать')).toEqual([]);
    expect(findGoalForbidden('Biotin 5000mkg')).toContain('units');
  });
});

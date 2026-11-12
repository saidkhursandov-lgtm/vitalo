import { chatDataBlock, checkChatAnswer, hasRedFlag, scrubPii, topicOrder, type ChatData } from './ai-chat';

const data = (over: Partial<ChatData> = {}): ChatData => ({
  lang: 'ru',
  cartBlock: '<данные>\n- id MAG-1 | Магний 400 мг\n- id D3-1 | Витамин D3\n</данные>',
  cart: [
    { ref: 'MAG-1', name: 'Магний 400 мг' },
    { ref: 'D3-1', name: 'Витамин D3' },
  ],
  evidence: [{ ref: 'MAG-1', substance: 'Магний', goal: 'sleep', level: 'B', helps: 'при напряжении', not_helps: 'если мешает кофеин' }],
  candidates: [],
  history: [],
  clarifyLeft: 2,
  question: 'Мне трудно заснуть',
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  kind: 'answer',
  goal: 'sleep',
  text: 'Для сна из вашей корзины может помочь магний, если мешает напряжение.',
  clarify_options: [],
  products: [
    { productId: 'MAG-1', fit: 'helps', text: 'Может помочь, если сон мешает напряжение.' },
    { productId: 'D3-1', fit: 'helps', text: 'Для сна этот товар обычно не берут.' },
  ],
  steps: ['Ложитесь в одно и то же время.'],
  followups: ['Как принимать их вместе?'],
  ...over,
});

describe('D-70: переписка с VITALO AI — проверки', () => {
  it('red flags: pregnancy, children, medicines, chest pain — RU and UZ; ordinary questions pass', () => {
    for (const t of ['Я беременна, можно?', 'Можно ли дать ребёнку?', 'Пью антибиотики', 'Болит в груди по ночам', 'Homiladorman, mumkinmi?', 'Bolamga beraymi?', 'Dori ichyapman']) {
      expect(hasRedFlag(t)).toBe(true);
    }
    for (const t of ['Мне трудно заснуть', 'Болят и хрустят суставы', 'Можно пить вместе?', 'Uxlay olmayapman', 'Сколько таблеток в банке?']) {
      expect(hasRedFlag(t)).toBe(false);
    }
  });

  it('phones and e-mails are cut out', () => {
    const t = scrubPii('Звоните +998 90 123 45 67 или пишите a.b@mail.ru', 'ru');
    expect(t).not.toContain('123 45 67');
    expect(t).not.toContain('mail.ru');
    expect(t).toContain('[почта скрыта]');
  });

  it('the data block: the history, the clarifications left, the question; an empty cart gets the catalogue', () => {
    const block = chatDataBlock(data({ history: [{ role: 'user', text: 'Плохо сплю' }, { role: 'ai', text: 'Трудно заснуть?' }], clarifyLeft: 1 }));
    expect(block).toContain('Покупатель: Плохо сплю');
    expect(block).toContain('VITALO AI: Трудно заснуть?');
    expect(block).toContain('осталось уточнений: 1');
    expect(block).toContain('<вопрос>Мне трудно заснуть</вопрос>');
    expect(block).not.toContain('<товары каталога');
    const empty = chatDataBlock(data({ cart: [], cartBlock: '', evidence: [], candidates: [{ ref: 'MAG-1', name: 'Магний', substances: ['Магний'], goal: 'sleep', level: 'B', helps: 'при напряжении' }] }));
    expect(empty).toContain('корзина пуста');
    expect(empty).toContain('- id MAG-1 | Магний');
  });

  it('an answer: the fit comes from our base — no approved row means «no_data»', () => {
    const r = checkChatAnswer(answer(), data());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.products).toEqual([
      { ref: 'MAG-1', fit: 'helps', text: 'Может помочь, если сон мешает напряжение.' },
      { ref: 'D3-1', fit: 'no_data', text: 'Для сна этот товар обычно не берут.' },
    ]);
    const compat = checkChatAnswer(answer({ goal: 'compat' }), data());
    expect(compat.ok && compat.answer.products.every((p) => p.fit === null)).toBe(true);
  });

  it('refusals: a foreign product, a clarification over the limit, doses and diagnoses, the wrong language', () => {
    expect(checkChatAnswer(answer({ products: [{ productId: 'OTHER', fit: 'helps', text: 'Может помочь при напряжении.' }] }), data())).toEqual({ ok: false, error: 'products' });
    const clarify = { kind: 'clarify', goal: 'sleep', text: 'Вам трудно заснуть или вы просыпаетесь?', clarify_options: ['Трудно заснуть', 'Просыпаюсь'], products: [], steps: [], followups: [] };
    expect(checkChatAnswer(clarify, data()).ok).toBe(true);
    expect(checkChatAnswer(clarify, data({ clarifyLeft: 0 }))).toEqual({ ok: false, error: 'clarify_limit' });
    expect(checkChatAnswer({ ...clarify, clarify_options: ['Одно'] }, data())).toEqual({ ok: false, error: 'options' });
    expect(checkChatAnswer(answer({ text: 'Принимайте по 400 мг магния перед сном каждый день.' }), data())).toEqual({ ok: false, error: 'forbidden_words' });
    // a dose inside our product name is not the model's dose
    expect(checkChatAnswer(answer({ text: 'Для сна может помочь Магний 400 мг из вашей корзины.' }), data()).ok).toBe(true);
    expect(checkChatAnswer(answer(), data({ lang: 'uz' }))).toEqual({ ok: false, error: 'language' });
    expect(checkChatAnswer(answer({ steps: ['a', 'b', 'c', 'd'] }), data())).toEqual({ ok: false, error: 'steps' });
    expect(checkChatAnswer({ kind: 'magic', text: 'Привет, как дела у вас?' }, data())).toEqual({ ok: false, error: 'kind' });
  });

  it('suggestions: the goals of the cart come first', () => {
    expect(topicOrder(['Магний'])[0]).toBe('sleep');
    expect(topicOrder(['Глюкозамин', 'Хондроитин'])[0]).toBe('joints');
    expect(topicOrder([])).toEqual(['sleep', 'stress', 'energy', 'joints', 'immunity', 'sport']);
  });
});

import { catalogBlock, chatDataBlock, checkChatAnswer, hasRedFlag, hintGoals, scrubPii, topicOrder, type CatalogItem, type ChatData } from './ai-chat';

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  ref: 'GLY-1',
  name: 'Магний глицинат',
  brand: 'NOW Foods',
  substances: ['Магний глицинат 200 мг'],
  audience: 'adult',
  goalLabels: ['сон'],
  goals: ['sleep', 'stress'],
  approved: [],
  ...over,
});

const data = (over: Partial<ChatData> = {}): ChatData => ({
  lang: 'ru',
  cartBlock: '<данные>\n- id MAG-1 | Магний 400 мг\n- id D3-1 | Витамин D3\n</данные>',
  cart: [
    { ref: 'MAG-1', name: 'Магний 400 мг' },
    { ref: 'D3-1', name: 'Витамин D3' },
  ],
  evidence: [{ ref: 'MAG-1', substance: 'Магний', goal: 'sleep', level: 'B', helps: 'при напряжении', not_helps: 'если мешает кофеин' }],
  catalog: [item(), item({ ref: 'CRE-1', name: 'Креатин', brand: null, substances: ['Креатин'], goalLabels: [], goals: ['sport'] })],
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
    expect(block).not.toContain('<каталог');
    expect(chatDataBlock(data({ cart: [], cartBlock: '', evidence: [] }))).toContain('корзина пуста');
    const cat = catalogBlock([item({ approved: [{ goal: 'sleep', level: 'B', helps: 'при напряжении' }] })]);
    expect(cat).toContain('- id GLY-1 | Магний глицинат (NOW Foods) | вещества: Магний глицинат 200 мг | кому: взрослым | цели: сон | одобрено врачом: сон (sleep), уровень B, когда помогает: при напряжении');
  });

  it('an answer: «helps» needs an approved row of our base, otherwise «maybe» (D-74)', () => {
    const r = checkChatAnswer(answer(), data());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.products).toEqual([
      { ref: 'MAG-1', fit: 'helps', text: 'Может помочь, если сон мешает напряжение.' },
      { ref: 'D3-1', fit: 'maybe', text: 'Для сна этот товар обычно не берут.' },
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

  it('D-74: the catalogue may be offered — up to 3 with an empty cart, 1 on top of a cart', () => {
    const empty = data({ cart: [], cartBlock: '', evidence: [] });
    const fromCatalog = (ids: string[]) => answer({ products: ids.map((id) => ({ productId: id, fit: 'helps', text: 'Мягкая форма, подходит для вечера.' })) });
    const r = checkChatAnswer(fromCatalog(['GLY-1']), empty);
    expect(r.ok && r.answer.products).toEqual([{ ref: 'GLY-1', fit: 'maybe', text: 'Мягкая форма, подходит для вечера.' }]);
    expect(checkChatAnswer(fromCatalog(['GLY-1', 'CRE-1']), empty).ok).toBe(true);
    const cart = answer({ products: [...answer().products as object[], { productId: 'GLY-1', fit: 'maybe', text: 'Если захотите, есть мягкая форма магния.' }] });
    expect(checkChatAnswer(cart, data()).ok).toBe(true);
    const two = answer({ products: [...answer().products as object[], { productId: 'GLY-1', fit: 'maybe', text: 'Мягкая форма магния.' }, { productId: 'CRE-1', fit: 'maybe', text: 'Креатин для спорта.' }] });
    expect(checkChatAnswer(two, data())).toEqual({ ok: false, error: 'products' });
  });

  it('D-74: English words are refused; names of our products and abbreviations are fine', () => {
    expect(checkChatAnswer(answer({ text: 'Магний influences качество сна по данным исследований.' }), data())).toEqual({ ok: false, error: 'language' });
    expect(checkChatAnswer(answer({ text: 'Магний помогает, the main thing — режим.' }), data())).toEqual({ ok: false, error: 'language' });
    expect(checkChatAnswer(answer({ text: 'Можно присмотреться к NOW Foods: там глицинат, а BCAA и GABA тут ни при чём.' }), data()).ok).toBe(true);
    const uz = data({ lang: 'uz' });
    const uzAnswer = (text: string) => answer({ text, products: [], steps: [], followups: [] });
    expect(checkChatAnswer(uzAnswer('Magniy uyquga yordam beradi, tadqiqotlarga koʻra.'), uz).ok).toBe(true);
    expect(checkChatAnswer(uzAnswer('Magniy sleep quality uchun yordam beradi.'), uz)).toEqual({ ok: false, error: 'language' });
  });

  it('D-74: a follow-up to a goal without products is dropped; fewer than 2 are topped up', () => {
    const r = checkChatAnswer(
      answer({ followups: [{ type: 'show_goal', goal: 'joints', text: 'А что есть для суставов?' }, { type: 'show_goal', goal: 'stress', text: 'А что поможет при стрессе?' }] }),
      data(),
    );
    expect(r.ok && r.answer.followups).toEqual(['А что поможет при стрессе?', 'Как принимать их вместе?']);
    const none = checkChatAnswer(answer({ products: [], followups: [] }), data({ cart: [], cartBlock: '', evidence: [] }));
    expect(none.ok && none.answer.followups).toEqual(['А что поможет при стрессе?', 'А что есть для спорта?']);
    expect(hintGoals(['Магний цитрат'])).toEqual(['sleep', 'stress']);
  });
});

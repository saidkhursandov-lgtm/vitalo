import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { ApiError, type CompatAnswer, type VitaloApi } from './api-client';
import { createBot } from './bot';

const REQ = '11111111-2222-4333-8444-555555555555';
const SPECIALIST = 7002;

interface Call {
  method: string;
  payload: Record<string, any>;
}

/** The bot with a fake Telegram and a fake API that records the specialist's answers. */
function setup(answer: (code: string, text?: string) => Promise<CompatAnswer> = async (code) => ({ result: 'answered', verdict: code === 'c' ? 'compatible' : code === 's' ? 'spread' : 'consult', by: 'Мадина' })) {
  const calls: Call[] = [];
  const asked: unknown[][] = [];
  const unused = async () => {
    throw new Error('not used here');
  };
  const api: VitaloApi = {
    user: async () => ({ registered: true, blocked: false, language: 'ru' }),
    staff: async () => ({ is_staff: true }),
    info: async () => ({ support_contact: null, about_ru: '', about_uz: '' }),
    saveContact: unused,
    receiptStart: unused,
    sendReceipt: unused,
    confirmReceipt: unused,
    rejectReceipt: unused,
    compatAnswer: async (id, requestId, code, text) => (asked.push([id, requestId, code, text]), answer(code, text)),
    staffLoginDecision: unused,
  };
  const bot = createBot({
    token: '1:TEST',
    api,
    urls: { miniApp: () => 'https://shop.example', admin: () => null },
    botInfo: { id: 1, is_bot: true, first_name: 'VITALO', username: 'vitalo_store_bot' } as never,
    download: async () => new Uint8Array(),
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: true } as never;
  });
  let n = 0;
  const from = { id: SPECIALIST, is_bot: false, first_name: 'Мадина', language_code: 'ru' };
  const run = async (update: Omit<Update, 'update_id'>) => {
    calls.length = 0;
    await bot.handleUpdate({ update_id: ++n, ...update } as Update);
    return [...calls];
  };
  return {
    asked,
    press: (data: string) =>
      run({
        callback_query: { id: String(++n), chat_instance: 'c', from, data, message: { message_id: 500, date: 0, chat: { id: SPECIALIST, type: 'private', first_name: 'x' }, text: 'Проверка совместимости' } } as never,
      }),
    text: (text: string) => run({ message: { message_id: ++n, date: 0, chat: { id: SPECIALIST, type: 'private', first_name: 'x' }, from, text } as never }),
  };
}

const answered = (calls: Call[]) => calls.find((c) => c.method === 'answerCallbackQuery')?.payload;
const buttons = (markup: any) => (markup?.inline_keyboard ?? []).flat().map((b: { callback_data: string }) => b.callback_data);

describe('3.4 compatibility answers in the bot', () => {
  it('a quick answer goes to the API; the specialist sees what was sent', async () => {
    const s = setup();
    const calls = await s.press(`cp:s:${REQ}`);
    expect(s.asked).toEqual([[SPECIALIST, REQ, 's', undefined]]);
    expect(answered(calls)).toMatchObject({ text: 'Ответ отправлен клиенту: Разнести по времени', show_alert: false });
  });

  it('a second answer and a closed request are explained', async () => {
    const already = setup(async () => ({ result: 'already', verdict: 'compatible', by: 'Админ' }));
    expect(answered(await already.press(`cp:c:${REQ}`))?.text).toBe('Уже ответил Админ: Совместимы');
    const closed = setup(async () => ({ result: 'closed' }));
    expect(answered(await closed.press(`cp:k:${REQ}`))?.text).toBe('Клиент изменил корзину — этот запрос закрыт, пришёл новый.');
  });

  it('a manager without the «специалист» mark is refused', async () => {
    const s = setup(async () => Promise.reject(new ApiError(403, 'FORBIDDEN_FOR_ROLE', '/x')));
    expect(answered(await s.press(`cp:c:${REQ}`))).toMatchObject({ text: 'Отвечать может только администратор или специалист.', show_alert: true });
  });

  it('«Ответить своим текстом»: label first, then the next message is the answer', async () => {
    const s = setup();
    const pick = await s.press(`cp:t:${REQ}`);
    expect(buttons(pick.find((c) => c.method === 'editMessageReplyMarkup')!.payload.reply_markup)).toEqual([`cp:tl:c:${REQ}`, `cp:tl:s:${REQ}`, `cp:tl:k:${REQ}`, `cp:tb:${REQ}`]);
    expect(s.asked).toEqual([]);

    const back = await s.press(`cp:tb:${REQ}`);
    expect(buttons(back.find((c) => c.method === 'editMessageReplyMarkup')!.payload.reply_markup)).toEqual([`cp:c:${REQ}`, `cp:s:${REQ}`, `cp:k:${REQ}`, `cp:t:${REQ}`]);

    const ask = await s.press(`cp:tl:k:${REQ}`);
    expect(ask.find((c) => c.method === 'sendMessage')!.payload.text).toContain('Метка: Нужна консультация');
    const reply = await s.text('Железо и кальций — с интервалом 4 часа.');
    expect(s.asked).toEqual([[SPECIALIST, REQ, 'k', 'Железо и кальций — с интервалом 4 часа.']]);
    expect(reply.find((c) => c.method === 'sendMessage')!.payload.text).toBe('Ответ отправлен клиенту: Нужна консультация специалиста');

    // the next text is an ordinary message again
    await s.text('спасибо');
    expect(s.asked).toHaveLength(1);
  });

  it('the bot keyboard matches the buttons the API sends', async () => {
    const { compatKeyboard } = await import('./compat');
    expect(buttons(compatKeyboard(REQ))).toEqual([`cp:c:${REQ}`, `cp:s:${REQ}`, `cp:k:${REQ}`, `cp:t:${REQ}`]);
  });
});

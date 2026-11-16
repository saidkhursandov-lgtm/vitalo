import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import type { VitaloApi } from './api-client';
import { createBot } from './bot';

const USER = 8001;

function setup(language: 'ru' | 'uz', fail = false) {
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const switched: [number, boolean][] = [];
  const unused = async () => {
    throw new Error('not used here');
  };
  const api: VitaloApi = {
    user: async () => ({ registered: true, blocked: false, language }),
    staff: async () => ({ is_staff: false }),
    info: async () => ({ support_contact: null, about_ru: '', about_uz: '' }),
    saveContact: unused,
    receiptStart: unused,
    sendReceipt: unused,
    confirmReceipt: unused,
    rejectReceipt: unused,
    compatAnswer: unused,
    staffLoginDecision: unused,
    courseReminders: async (id, on) => {
      if (fail) throw new Error('down');
      switched.push([id, on]);
      return { saved: true };
    },
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
  const markup = { inline_keyboard: [[{ text: 'Повторить', web_app: { url: 'https://shop.example/product/1' } }], [{ text: 'Не напоминать', callback_data: 'cr:off' }]] };
  const press = async () => {
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: '1',
        chat_instance: 'c',
        from: { id: USER, is_bot: false, first_name: 'A', language_code: 'ru' },
        data: 'cr:off',
        message: { message_id: 10, date: 0, chat: { id: USER, type: 'private', first_name: 'A' }, text: 'Курс', reply_markup: markup },
      },
    } as unknown as Update);
    return calls;
  };
  return { press, switched };
}

describe('4.2 «Не напоминать» under «Курс заканчивается»', () => {
  it('switches the reminders off, keeps «Повторить», answers in the shop language', async () => {
    const s = setup('uz');
    const calls = await s.press();
    expect(s.switched).toEqual([[USER, false]]);
    const edit = calls.find((c) => c.method === 'editMessageReplyMarkup')!;
    expect(edit.payload.reply_markup.inline_keyboard).toEqual([[{ text: 'Повторить', web_app: { url: 'https://shop.example/product/1' } }]]);
    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text).toContain('boshqa eslatmaymiz');
  });

  it('the API is down: the button stays, the customer is told to try again', async () => {
    const s = setup('ru', true);
    const calls = await s.press();
    expect(calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(false);
    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.payload).toMatchObject({ text: 'Не получилось. Попробуйте ещё раз.', show_alert: true });
  });
});

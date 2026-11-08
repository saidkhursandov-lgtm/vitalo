import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import type { VitaloApi } from './api-client';
import { createBot } from './bot';

const REQ = '11111111-2222-4333-8444-555555555555';
const ADMIN = 7001;

function setup(decide: (approve: boolean) => Promise<{ result: string }>) {
  const calls: { method: string; payload: Record<string, any> }[] = [];
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
    compatAnswer: unused,
    staffLoginDecision: async (id, requestId, approve) => (asked.push([id, requestId, approve]), decide(approve)),
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
  const from = { id: ADMIN, is_bot: false, first_name: 'Саид', language_code: 'ru' };
  const press = async (data: string) => {
    calls.length = 0;
    await bot.handleUpdate({
      update_id: ++n,
      callback_query: { id: String(n), chat_instance: 'c', from, data, message: { message_id: 9, date: 0, chat: { id: ADMIN, type: 'private', first_name: 'x' }, text: 'Вход в админку' } },
    } as never as Update);
    return [...calls];
  };
  return { asked, press };
}

describe('admin login confirmation in the bot (генплан, этап 3)', () => {
  it('«Подтвердить» passes the choice to the API and replaces the message', async () => {
    const t = setup(async () => ({ result: 'approved' }));
    const calls = await t.press(`sl:ok:${REQ}`);
    expect(t.asked).toEqual([[ADMIN, REQ, true]]);
    expect(calls.find((c) => c.method === 'editMessageText')?.payload.text).toMatch(/Вход подтверждён/);
  });

  it('«Это не я» → denied; an expired request says so', async () => {
    const t = setup(async (approve) => ({ result: approve ? 'expired' : 'denied' }));
    expect((await t.press(`sl:no:${REQ}`)).find((c) => c.method === 'editMessageText')?.payload.text).toMatch(/Вход отклонён/);
    expect((await t.press(`sl:ok:${REQ}`)).find((c) => c.method === 'editMessageText')?.payload.text).toMatch(/Время подтверждения вышло/);
  });

  it('API error: only a short notice, the buttons stay', async () => {
    const t = setup(async () => {
      throw new Error('down');
    });
    const calls = await t.press(`sl:ok:${REQ}`);
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.payload.text).toMatch(/Не получилось/);
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
  });
});

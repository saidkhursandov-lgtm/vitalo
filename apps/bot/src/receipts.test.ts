import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { ApiError, type ReceiptDecision, type ReceiptSaved, type VitaloApi } from './api-client';
import { createBot } from './bot';
import { orderIdFromStart } from './receipts';

const ORDER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const RECEIPT = '11111111-2222-4333-8444-555555555555';
const CUSTOMER = 42;
const MANAGER = 7001;

interface Call {
  method: string;
  payload: Record<string, any>;
}

/** The bot with a fake Telegram and a fake VITALO API that records what the bot asked for. */
function setup(over: Partial<VitaloApi> = {}) {
  const calls: Call[] = [];
  const asked: Record<string, unknown[]> = {};
  const note = (name: string, ...args: unknown[]) => (asked[name] = args);
  const saved: ReceiptSaved = {
    result: 'saved',
    receipt_id: RECEIPT,
    order_id: ORDER,
    order_number: 'VTL-20261101-0001',
    total_uzs: 125_000,
    lang: 'ru',
    check_hours: { from: '08:00', to: '22:00' },
    check_within_hours: 3,
    caption: 'Чек по заказу №VTL-20261101-0001',
    staff: [{ telegram_id: String(MANAGER) }],
  };
  const api: VitaloApi = {
    user: async () => ({ registered: true, blocked: false, language: 'ru' }),
    staff: async () => ({ is_staff: false }),
    info: async () => ({ support_contact: null, about_ru: '', about_uz: '' }),
    saveContact: async () => ({ saved: true }),
    receiptStart: async (id, orderId) => (note('receiptStart', id, orderId), { order_id: ORDER, order_number: saved.order_number, total_uzs: 125_000, lang: 'ru' }),
    sendReceipt: async (id, orderId, file) => (note('sendReceipt', id, orderId, file), saved),
    confirmReceipt: async (id, receiptId) => (note('confirmReceipt', id, receiptId), { result: 'confirmed', order_number: saved.order_number }),
    rejectReceipt: async (id, receiptId, reason) => (note('rejectReceipt', id, receiptId, reason), { result: 'rejected', order_number: saved.order_number, reason: 'Сумма не совпадает' } as ReceiptDecision),
    compatAnswer: async () => ({ result: 'closed' }),
    staffLoginDecision: async () => ({ result: 'approved' }),
    ...over,
  };
  const bot = createBot({
    token: '1:TEST',
    api,
    urls: { miniApp: () => 'https://shop.example', admin: () => null },
    botInfo: { id: 1, is_bot: true, first_name: 'VITALO', username: 'vitalo_store_bot' } as never,
    download: async () => new Uint8Array([1, 2, 3]),
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: true } as never;
  });
  let n = 0;
  const from = (id: number) => ({ id, is_bot: false, first_name: id === MANAGER ? 'Мадина' : 'Ali', language_code: 'ru' });
  const run = async (update: Omit<Update, 'update_id'>) => {
    calls.length = 0;
    await bot.handleUpdate({ update_id: ++n, ...update } as Update);
    return calls;
  };
  const message = (id: number, extra: Record<string, unknown>) =>
    run({ message: { message_id: ++n, date: 0, chat: { id, type: 'private', first_name: 'x' }, from: from(id), ...extra } as never });
  return {
    asked,
    start: (payload: string) => message(CUSTOMER, { text: `/start ${payload}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] }),
    photo: () => message(CUSTOMER, { photo: [{ file_id: 'small', file_unique_id: 's', width: 90, height: 90 }, { file_id: 'big', file_unique_id: 'b', width: 900, height: 900, file_size: 50_000 }] }),
    document: (mime: string, size = 1000) => message(CUSTOMER, { document: { file_id: 'doc', file_unique_id: 'd', mime_type: mime, file_size: size } }),
    text: (id: number, text: string) => message(id, { text }),
    press: (data: string) =>
      run({
        callback_query: {
          id: String(++n),
          chat_instance: 'c',
          from: from(MANAGER),
          data,
          message: { message_id: 500, date: 0, chat: { id: MANAGER, type: 'private', first_name: 'x' }, caption: 'Чек по заказу №VTL-20261101-0001', photo: [] },
        } as never,
      }),
  };
}

const texts = (calls: Call[]) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
const buttons = (markup: any) => (markup?.inline_keyboard ?? []).flat().map((b: { text: string; callback_data: string }) => [b.text, b.callback_data]);

describe('3.1 receipt in the bot', () => {
  it('reads the order from the «Отправить скриншот чека в бот» link', () => {
    expect(orderIdFromStart(`rc_${ORDER.replace(/-/g, '')}`)).toBe(ORDER);
    expect(orderIdFromStart('rc_xyz')).toBeNull();
    expect(orderIdFromStart('FRIEND_42')).toBeNull();
  });

  it('/start rc_<order> asks for the receipt of that order (no menu greeting)', async () => {
    const s = setup();
    const calls = await s.start(`rc_${ORDER.replace(/-/g, '')}`);
    expect(s.asked.receiptStart).toEqual([CUSTOMER, ORDER]);
    expect(texts(calls)).toEqual(['Пришлите сюда фото или PDF чека об оплате заказа №VTL-20261101-0001 на 125 000 сум.']);
  });

  it('a refused link explains why (paid order)', async () => {
    const s = setup({ receiptStart: async () => Promise.reject(new ApiError(409, 'ORDER_PAID', '/x')) });
    expect(texts(await s.start(`rc_${ORDER.replace(/-/g, '')}`))).toEqual(['Этот заказ уже оплачен — чек не нужен.']);
  });

  it('a photo goes to the API for that order; the customer is told when it will be checked; managers get it with buttons', async () => {
    const s = setup();
    await s.start(`rc_${ORDER.replace(/-/g, '')}`);
    const calls = await s.photo();
    const [, orderId, file] = s.asked.sendReceipt as [number, string, { file_id: string; mime: string; data: Uint8Array }];
    expect(orderId).toBe(ORDER);
    expect(file).toMatchObject({ file_id: 'big', mime: 'image/jpeg' }); // the largest size
    expect(texts(calls)).toEqual(['Чек по заказу №VTL-20261101-0001 получен. Проверим оплату в течение 3 ч в рабочее время (08:00–22:00) и пришлём сообщение.']);
    const toStaff = calls.find((c) => c.method === 'sendPhoto')!;
    expect(toStaff.payload).toMatchObject({ chat_id: String(MANAGER), photo: 'big', caption: 'Чек по заказу №VTL-20261101-0001' });
    expect(buttons(toStaff.payload.reply_markup)).toEqual([
      ['Подтвердить оплату', `rc:ok:${RECEIPT}`],
      ['Отклонить', `rc:no:${RECEIPT}`],
    ]);
  });

  it('a PDF is forwarded as a document; other files and big files are refused before download', async () => {
    const s = setup();
    expect((await s.document('application/pdf')).some((c) => c.method === 'sendDocument')).toBe(true);
    expect(texts(await s.document('application/zip'))).toEqual(['Пришлите фото или PDF-файл чека.']);
    expect(texts(await s.document('application/pdf', 30 * 1024 * 1024))).toEqual(['Файл больше 10 МБ. Пришлите скриншот чека.']);
  });

  it('without an open order waiting for a transfer the customer is told how to send it', async () => {
    const s = setup({ sendReceipt: async () => Promise.reject(new ApiError(409, 'ORDER_NOT_FOUND', '/x')) });
    expect(texts(await s.photo())[0]).toContain('Не нашли заказ');
  });

  it('«Подтвердить оплату»: the API decides; the message shows who confirmed and loses its buttons', async () => {
    const s = setup();
    const calls = await s.press(`rc:ok:${RECEIPT}`);
    expect(s.asked.confirmReceipt).toEqual([MANAGER, RECEIPT]);
    const edit = calls.find((c) => c.method === 'editMessageCaption')!;
    expect(edit.payload.caption).toBe('Чек по заказу №VTL-20261101-0001\n\nОплата подтверждена — Мадина');
    expect(buttons(edit.payload.reply_markup)).toEqual([]);
    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text).toBe('Оплата подтверждена — Мадина');
  });

  it('a warehouse employee cannot confirm (the API says 403)', async () => {
    const s = setup({ confirmReceipt: async () => Promise.reject(new ApiError(403, 'FORBIDDEN_FOR_ROLE', '/x')) });
    const answer = (await s.press(`rc:ok:${RECEIPT}`)).find((c) => c.method === 'answerCallbackQuery')!;
    expect(answer.payload).toMatchObject({ text: 'Проверять чеки может только менеджер или администратор.', show_alert: true });
  });

  it('«Отклонить» offers reasons; a reason from the list rejects', async () => {
    const s = setup();
    const menu = (await s.press(`rc:no:${RECEIPT}`)).find((c) => c.method === 'editMessageReplyMarkup')!;
    expect(buttons(menu.payload.reply_markup).map(([t]: string[]) => t)).toEqual(['Сумма не совпадает', 'Чек не читается', 'Платёж не поступил', 'Другое — написать', '‹ Назад']);
    const calls = await s.press(`rc:r:amount:${RECEIPT}`);
    expect(s.asked.rejectReceipt).toEqual([MANAGER, RECEIPT, { code: 'amount' }]);
    expect(calls.find((c) => c.method === 'editMessageCaption')!.payload.caption).toContain('Чек отклонён — Мадина. Причина: Сумма не совпадает');
  });

  it('«Другое — написать»: the next message of that employee is the reason', async () => {
    const s = setup();
    expect(texts(await s.press(`rc:rt:${RECEIPT}`))).toEqual(['Напишите причину отказа одним сообщением — клиент её увидит.']);
    const calls = await s.text(MANAGER, 'Перевод с чужой карты');
    expect(s.asked.rejectReceipt).toEqual([MANAGER, RECEIPT, { text: 'Перевод с чужой карты' }]);
    expect(calls.find((c) => c.method === 'editMessageCaption')!.payload).toMatchObject({ chat_id: MANAGER, message_id: 500 });
    // the next message is an ordinary one again
    delete s.asked.rejectReceipt;
    await s.text(MANAGER, 'привет');
    expect(s.asked.rejectReceipt).toBeUndefined();
  });
});

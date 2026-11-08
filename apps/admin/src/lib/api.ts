/**
 * fetch wrapper for /api (proxied to localhost:3000 by Vite in dev). Inside Telegram the staff token lives in
 * sessionStorage (Bearer); in an ordinary browser (admin.vitalo.uz, D-56) the session is an HttpOnly cookie the page
 * never sees. Every request carries `x-vitalo-admin: 1`: the API refuses cookie changes without it (CSRF).
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const TOKEN_KEY = 'vitalo.staff.token';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly body: Record<string, unknown>,
  ) {
    const m = body.message;
    super(Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : `HTTP ${status}`);
  }
}

let token: string | null = (() => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();
let onUnauthorized: (() => void) | null = null;

export function setToken(value: string | null) {
  token = value;
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: keep the in-memory token */
  }
}

export const hasToken = () => token !== null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

/** `anonymous`: no staff token and no sign-out on 401 (the label page authorises with a print ticket instead). */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string>; anonymous?: boolean } = {},
): Promise<T> {
  const auth = init.anonymous ? null : token;
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'x-vitalo-admin': '1',
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(auth && { authorization: `Bearer ${auth}` }),
      ...init.headers,
    },
    body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !init.anonymous) {
      setToken(null);
      onUnauthorized?.();
    }
    throw new ApiError(res.status, body.code, body);
  }
  return body as T;
}

/** 3.1: a private file (a payment receipt) as a Blob — it needs the staff token, so it cannot be a plain <img src>. */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, undefined, {});
  return res.blob();
}

/** Idempotency-Key for one attempt (randomUUID needs https or localhost; the fallback is unique enough). */
export const newKey = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const ERRORS: Record<string, string> = {
  FORBIDDEN_FOR_ROLE: 'У вашей роли нет прав на это действие',
  PURCHASE_NOT_FOUND: 'Закупка с таким номером Ozon в этом аккаунте не найдена',
  LINE_NOT_FOUND: 'Этой позиции нет в закупке',
  IDEMPOTENCY_KEY_REUSED: 'Запрос уже отправлялся с другими данными — обновите страницу и попробуйте снова',
  UNKNOWN_DICTIONARY_VALUE: 'Значение справочника не найдено — обновите страницу',
  YANDEX_SYNC_ANSWER_REQUIRED: 'Цена Яндекса изменилась — ответьте, изменили ли вы её в Яндекс Маркете',
  COST_FORBIDDEN: 'Себестоимость и закупочную цену видит и вводит только администратор',
  TIMEOUT_SHORTER_THAN_REMINDER: 'Срок резерва не может быть короче времени напоминания клиенту об оплате (Тексты и контакты)',
  ORDER_LOCKED: 'Заказ передан в доставку — изменять и отменять его здесь нельзя',
  INVALID_STATUS_TRANSITION: 'Такой переход статуса недопустим',
  PAID_ORDER_CITY_LOCKED: 'Город доставки оплаченного заказа менять нельзя',
  ORDER_CANCELLED: 'Заказ уже отменён',
  NO_BANK_TRANSFER_PAYMENT: 'У заказа нет ожидающего банковского перевода',
  ORDER_NOT_CANCELLABLE: 'Этот заказ нельзя отменить',
  STOCK_RESERVED: 'Эти единицы зарезервированы заказами',
  NOTHING_TO_ADJUST: 'Количество совпадает с текущим — корректировать нечего',
  NO_STOCK_ROW: 'У товара нет остатка на этом складе',
  SKU_TAKEN: 'Товар с таким SKU уже есть',
  UNKNOWN_CATEGORY: 'Неизвестная категория',
  UNSUPPORTED_IMAGE: 'Можно загружать только JPEG, PNG или WebP',
  FILE_REQUIRED: 'Выберите файл',
  TARIFF_EXISTS: 'Активный тариф для этого региона/города уже есть',
  INVALID_ADDRESS: 'Город не относится к выбранному региону',
  DELIVERY_UNAVAILABLE: 'Нет тарифа доставки для этого города',
  STAFF_EXISTS: 'Сотрудник с таким Telegram ID уже есть',
  CANNOT_CHANGE_SELF: 'Нельзя менять свою роль или блокировать себя',
  UNIT_TRACKED: 'Товар учитывается по единицам: используйте «Приёмка»',
  OVERRIDE_REASON_REQUIRED: 'Укажите причину: операция в обход учёта по единицам',
  SESSION_NOT_OPEN: 'Эта приёмка уже завершена или отменена — обновите страницу',
  SESSION_CANCELLED: 'Эта приёмка отменена',
  SESSION_EMPTY: 'В приёмке нет принятых единиц — сначала создайте Physical ID',
  SESSION_NOT_FOUND: 'Приёмка не найдена',
  NOT_EXPECTED: 'Этого товара нет в ожидаемых закупках выбранного источника',
  EXPIRY_IN_PAST: 'Срок годности уже прошёл — такой товар не принимаем',
  EXPIRY_INVALID: 'Срок годности: введите дату как ДД.ММ.ГГГГ',
  EXPIRY_QTY_MISMATCH: 'Сумма количеств по срокам годности должна быть равна принятому количеству',
  BAD_PHYSICAL_ID: 'Это не Physical ID: введите, например, V-000184 или 184',
  UNIT_NOT_FOUND: 'Единица с таким Physical ID не найдена',
  UNIT_VOIDED: 'Отменённые единицы не печатаются',
  LINE_HAS_UNITS: 'По этой строке идёт приёмка (созданы Physical ID) — убрать её нельзя',
  NO_MAIN_WAREHOUSE: 'Не удалось определить основной склад (Ташкент)',
  SOURCE_REQUIRED: 'Выберите один источник: Ozon-аккаунт или поставщика',
  UNKNOWN_SOURCE: 'Источник не найден или в архиве',
  CHECK_REQUIRED: 'Отметьте, что срок годности и целостность банки проверены',
  NOTHING_TO_CORRECT: 'Укажите новый срок годности или статус',
  ORDER_NOT_FOUND: 'Заказ не найден',
  UNKNOWN_PRODUCT: 'Товар не найден',
  NOTHING_TO_PRINT: 'Выберите единицы или приёмку',
  TOO_MANY_UNITS: 'Слишком много единиц сразу — печатайте всю приёмку кнопкой «Напечатать этикетки»',
  PRINT_TICKET_EXPIRED: 'Ссылка на печать устарела (действует 15 минут) — нажмите «Напечатать этикетки» в админке ещё раз',
  BOT_UNREACHABLE: 'Бот не смог отправить подтверждение. Откройте бота VITALO в Telegram, нажмите «Старт» и войдите снова.',
  BOT_NOT_CONFIGURED: 'Вход через Telegram не настроен на сервере',
  BAD_TELEGRAM_LOGIN: 'Telegram не подтвердил вход. Попробуйте ещё раз.',
  NOT_STAFF: 'Этот Telegram-аккаунт не сотрудник VITALO или заблокирован',
  BAD_CODE: 'Код не подходит или уже использован',
  TOO_MANY_ATTEMPTS: 'Слишком много попыток входа. Попробуйте через 15 минут.',
  ALREADY_USED: 'Этот вход уже выполнен — обновите страницу',
  CSRF: 'Обновите страницу и попробуйте ещё раз',
  BAD_IHERB_URL: 'Ссылка iHerb должна вести на страницу товара, например https://uz.iherb.com/pr/…/12345',
  IHERB_TAKEN: 'Эта ссылка iHerb уже указана у другого товара',
  PRINT_TICKET_INVALID: 'Ссылка на печать недействительна (или вы вышли из админки) — откройте печать из админки заново',
};

/** Russian text for an API error (validation messages are shown as they come). */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code && ERRORS[e.code]) return ERRORS[e.code];
    if (e.status === 413) return 'Файл слишком большой (максимум 5 МБ)';
    if (e.status === 400) return `Проверьте поля: ${e.message}`;
    if (e.status === 404) return 'Не найдено';
    return e.message;
  }
  return 'Нет связи с сервером. Запущен ли API (apps/api: npm run start:dev)?';
}

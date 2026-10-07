/** fetch wrapper for /api (proxied to localhost:3000 by Vite in dev). Staff token lives in sessionStorage. */
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

export async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
      ...init.headers,
    },
    body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null);
      onUnauthorized?.();
    }
    throw new ApiError(res.status, body.code, body);
  }
  return body as T;
}

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

import type { Lang } from './texts';

export interface UserSummary {
  registered: boolean;
  blocked: boolean;
  first_name?: string;
  language?: Lang;
  bonus_balance_uzs?: number;
  orders_total?: number;
  favorites_count?: number;
  addresses_count?: number;
  orders?: { id: string; order_number: string; status: string; payment_reported?: boolean; payment_method?: string | null; total_uzs: number; created_at: string }[];
}

export interface StaffInfo {
  is_staff: boolean;
  role?: string;
  name?: string;
}

export interface ShopInfo {
  support_contact: string | null;
  support_url?: string | null;
  /** Profile line "VITALO Bonus: скоро" (switched in the admin panel). */
  bonus_teaser?: boolean;
  about_ru: string;
  about_uz: string;
}

/** 3.1: the order a receipt is for (from the «Отправить скриншот чека в бот» link). */
export interface ReceiptTarget {
  order_id: string;
  order_number: string;
  total_uzs: number;
  lang: Lang;
}

export interface ReceiptSaved extends ReceiptTarget {
  result: 'saved' | 'duplicate';
  receipt_id: string;
  check_hours: { from: string; to: string };
  check_within_hours: number;
  /** Staff caption (Russian), only for a new receipt */
  caption?: string;
  /** Managers and admins who get the receipt with the buttons */
  staff: { telegram_id: string }[];
}

export interface ReceiptFile {
  data: Uint8Array;
  mime: string;
  file_id: string;
  file_unique_id: string;
}

export interface ReceiptDecision {
  result: 'confirmed' | 'rejected' | 'already_paid' | 'already_confirmed' | 'already_rejected';
  order_number: string;
  by?: string | null;
  reason?: string | null;
}

/** 3.4: what the API did with the specialist's answer. */
export type CompatAnswer =
  | { result: 'answered'; verdict: string; by: string }
  | { result: 'already'; verdict: string | null; by: string | null }
  | { result: 'closed' };

/** The API refused: `code` says why (ORDER_PAID, FORBIDDEN_FOR_ROLE, …). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    path: string,
  ) {
    super(`VITALO API ${path} -> HTTP ${status}${code ? ` ${code}` : ''}`);
  }
}

/** What the bot needs from the VITALO API (faked in tests). */
export interface VitaloApi {
  user(telegramId: number): Promise<UserSummary>;
  staff(telegramId: number): Promise<StaffInfo>;
  info(): Promise<ShopInfo>;
  /** Phone the customer shared with the bot (only their own number is accepted). */
  saveContact(telegramId: number, phone: string, contactUserId: number): Promise<{ saved: boolean }>;
  /** 3.1: receipts. The API checks the owner, the order and the employee's role; the bot only passes things on. */
  receiptStart(telegramId: number, orderId: string | null): Promise<ReceiptTarget>;
  sendReceipt(telegramId: number, orderId: string | null, file: ReceiptFile): Promise<ReceiptSaved>;
  confirmReceipt(staffTelegramId: number, receiptId: string): Promise<ReceiptDecision>;
  rejectReceipt(staffTelegramId: number, receiptId: string, reason: { code?: string; text?: string }): Promise<ReceiptDecision>;
  /** 3.4: the specialist's answer — code c | s | k (Совместимы / Разнести / Консультация), optional own text. */
  compatAnswer(staffTelegramId: number, requestId: string, code: string, text?: string): Promise<CompatAnswer>;
  /** Генплан, этап 3: «Подтвердить» / «Это не я» on a login to the admin panel from a new browser. */
  staffLoginDecision(staffTelegramId: number, requestId: string, approve: boolean): Promise<{ result: string }>;
}

/** Calls /api/internal/bot/* with the shared secret header. */
export class HttpVitaloApi implements VitaloApi {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  user = (id: number) => this.get<UserSummary>(`/internal/bot/users/${id}`);
  staff = (id: number) => this.get<StaffInfo>(`/internal/bot/staff/${id}`);
  info = () => this.get<ShopInfo>('/internal/bot/info');
  /** Active admins and managers for «Новые адреса VITALO» (dev tunnel). */
  staffNotify = () => this.get<{ recipients: { telegram_id: string; role: string }[] }>('/internal/bot/staff-notify');
  saveContact = (id: number, phone: string, contactUserId: number) =>
    this.post<{ saved: boolean }>(`/internal/bot/users/${id}/contact`, { phone, contact_user_id: contactUserId });
  receiptStart = (id: number, orderId: string | null) => this.post<ReceiptTarget>('/internal/bot/receipts/start', { telegram_id: String(id), order_id: orderId });
  confirmReceipt = (staffId: number, receiptId: string) => this.post<ReceiptDecision>(`/internal/bot/receipts/${receiptId}/confirm`, { telegram_id: String(staffId) });
  rejectReceipt = (staffId: number, receiptId: string, reason: { code?: string; text?: string }) =>
    this.post<ReceiptDecision>(`/internal/bot/receipts/${receiptId}/reject`, { telegram_id: String(staffId), ...reason });
  compatAnswer = (staffId: number, requestId: string, code: string, text?: string) =>
    this.post<CompatAnswer>(`/internal/bot/compat/${requestId}/answer`, { telegram_id: String(staffId), verdict: code, ...(text !== undefined && { text }) });

  staffLoginDecision = (staffId: number, requestId: string, approve: boolean) =>
    this.post<{ result: string }>(`/internal/bot/staff-login/${requestId}/decision`, { telegram_id: String(staffId), approve });

  async sendReceipt(id: number, orderId: string | null, file: ReceiptFile): Promise<ReceiptSaved> {
    const form = new FormData();
    form.set('telegram_id', String(id));
    form.set('order_id', orderId ?? '');
    form.set('file_id', file.file_id);
    form.set('file_unique_id', file.file_unique_id);
    form.set('mime', file.mime);
    form.set('file', new Blob([file.data], { type: file.mime }), 'receipt');
    const res = await fetch(`${this.baseUrl}/internal/bot/receipts`, { method: 'POST', headers: { 'x-bot-secret': this.secret }, body: form, signal: AbortSignal.timeout(30_000) });
    return this.read<ReceiptSaved>(res, '/internal/bot/receipts');
  }

  private async read<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      throw new ApiError(res.status, body?.code, path);
    }
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'x-bot-secret': this.secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return this.read<T>(res, path);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'x-bot-secret': this.secret },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`VITALO API ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

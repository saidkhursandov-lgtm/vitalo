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
  orders?: { id: string; order_number: string; status: string; payment_reported?: boolean; total_uzs: number; created_at: string }[];
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

/** What the bot needs from the VITALO API (faked in tests). */
export interface VitaloApi {
  user(telegramId: number): Promise<UserSummary>;
  staff(telegramId: number): Promise<StaffInfo>;
  info(): Promise<ShopInfo>;
  /** Phone the customer shared with the bot (only their own number is accepted). */
  saveContact(telegramId: number, phone: string, contactUserId: number): Promise<{ saved: boolean }>;
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
  saveContact = (id: number, phone: string, contactUserId: number) =>
    this.post<{ saved: boolean }>(`/internal/bot/users/${id}/contact`, { phone, contact_user_id: contactUserId });

  private async post<T>(path: string, body: object): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'x-bot-secret': this.secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`VITALO API ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
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

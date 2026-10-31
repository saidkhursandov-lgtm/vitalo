import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BONUS_TEASER_DEFAULT, HOME_CONTENT_DEFAULT, MANIFEST_DEFAULT } from './home-content';
import { CART_UPSELL_DEFAULT } from '../cart/upsell';

/** Business settings editable by admins (table `settings`, JSON values). */
export const SETTING_KEYS = {
  bankTransferDetails: 'bank_transfer_details',
  cardTransferDetails: 'card_transfer_details',
  paymentHint: 'payment_hint',
  productDisclaimer: 'product_disclaimer',
  supportContact: 'support_contact',
  paymentCheckHours: 'payment_check_hours',
  deliveryDaysLabel: 'delivery_days_label',
  paymentReminderHours: 'payment_reminder_hours',
  paymentCheckReminderHours: 'payment_check_reminder_hours',
  homeContent: 'home_content',
  bonusTeaser: 'bonus_teaser',
  labelSize: 'label_size',
  checkoutOptions: 'checkout_options',
  manifest: 'home_manifest',
  cartUpsell: 'cart_upsell',
} as const;

/**
 * Release 1: checkout switches (Настройки → Оплата). Not inserted by a migration: the default is used until an admin saves one.
 * - cod_max_total_uzs: the largest order total for «Оплата при получении» (Tashkent only); null = no limit;
 * - show_online_soon: release 1 switch for Payme / Click / Uzum; since 2.1 it only mirrors `online` (true = some system is «Скоро»);
 * - first_order_free_delivery: the customer's first order (no other orders except cancelled ones) is delivered free;
 * - online (2.1, D-20): hidden / soon / live per system; missing (saved before 2.1) = all «Скоро» (see onlineModes()).
 */
export interface CheckoutOptions {
  cod_max_total_uzs: number | null;
  show_online_soon: boolean;
  first_order_free_delivery: boolean;
  online?: Partial<Record<'payme' | 'click' | 'uzum', 'hidden' | 'soon' | 'live'>>;
}

/** Physical ID label paper (XP-365B: print width up to 76 mm). */
export interface LabelSize {
  width_mm: number;
  height_mm: number;
}

export interface LocalizedText {
  ru: string;
  uz: string;
}

/** Daily window (Tashkent time, "HH:MM") when managers confirm payments. */
export interface PaymentCheckHours {
  from: string;
  to: string;
}

export interface CardTransferDetails {
  card_number: string; // digits only
  recipient: string;
}

/** Payment methods paid by a manual transfer and confirmed by a manager ("Я оплатил(а)" flow). */
export const MANUAL_PAYMENT_METHODS = ['card_transfer', 'bank_transfer'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

/** Release 1: «Оплата при получении» (cash or a transfer to the courier), Tashkent only; confirmed by a manager, no «Я оплатил(а)». */
export const COD_METHOD = 'cod';
/** Methods a manager confirms in the admin panel: the manual transfers and cash on delivery. */
export const CONFIRMABLE_PAYMENT_METHODS = [...MANUAL_PAYMENT_METHODS, COD_METHOD] as const;

/** Initial values (also inserted by migration 20261003120000 "add if missing"). Card details are TEST values. */
export const SETTING_DEFAULTS = {
  product_disclaimer: { ru: 'БАД. НЕ ЯВЛЯЕТСЯ ЛЕКАРСТВЕННЫМ СРЕДСТВОМ.', uz: 'BFQ. DORI VOSITASI EMAS.' } as LocalizedText,
  card_transfer_details: { card_number: '8600000000000000', recipient: 'ТЕСТОВЫЙ ПОЛУЧАТЕЛЬ (ТЕСТОВЫЕ ДАННЫЕ)' } as CardTransferDetails,
  payment_hint: {
    ru: 'Переведите сумму заказа на карту, затем нажмите «Я оплатил(а)». После проверки платежа менеджером статус заказа изменится на «Оплачен», и мы начнём сборку.',
    uz: 'Buyurtma summasini kartaga o‘tkazing, so‘ng «To‘ladim» tugmasini bosing. Menejer to‘lovni tekshirgach, buyurtma holati «To‘langan»ga o‘zgaradi va biz yig‘ishni boshlaymiz.',
  } as LocalizedText,
  support_contact: '@VITALO_support' as string,
  payment_check_hours: { from: '08:00', to: '22:00' } as PaymentCheckHours,
  delivery_days_label: { ru: 'рабочих дней', uz: 'ish kuni' } as LocalizedText,
  home_content: HOME_CONTENT_DEFAULT,
  /** D3: the bot reminds about an unpaid order this many hours before the automatic cancellation. */
  payment_reminder_hours: 3 as number,
  /** Stage 0.2: admins/managers are reminded once when «Я оплатил(а)» stays unconfirmed this many hours (1–48). */
  payment_check_reminder_hours: 3 as number,
  bonus_teaser: BONUS_TEASER_DEFAULT,
  /** Physical ID label 58×40 mm. Not inserted by a migration: the default is used until an admin saves one. */
  label_size: { width_mm: 58, height_mm: 40 } as LabelSize,
  checkout_options: { cod_max_total_uzs: null, show_online_soon: false, first_order_free_delivery: false } as CheckoutOptions,
  /** 2.4: «Как VITALO отбирает добавки». Not inserted by a migration: the default is used until an admin saves one. */
  home_manifest: MANIFEST_DEFAULT,
  /** 3.1: «Настройки → Корзина» — products under the free-delivery bar. Not inserted by a migration: on by default. */
  cart_upsell: CART_UPSELL_DEFAULT,
};

/** "@VITALO_support" / "t.me/VITALO_support" / a full URL -> https://t.me/VITALO_support (null if not a Telegram handle). */
export function supportLink(contact: string): string | null {
  const m = contact.trim().match(/^(?:https?:\/\/)?(?:t\.me\/|@)?([A-Za-z0-9_]{5,32})$/);
  return m ? `https://t.me/${m[1]}` : null;
}

export interface BankTransferDetails {
  recipient: string;
  bank_name: string;
  account: string;
  mfo: string;
  inn: string;
  purpose_template: string; // "{order_number}" is replaced with the order number
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get<T>(key: string): Promise<T | null> {
    const row = await this.prisma.settings.findUnique({ where: { key } });
    return (row?.value as T | undefined) ?? null;
  }

  /** Value from the table, or the built-in default when the admin has not saved one. */
  async getOrDefault<K extends keyof typeof SETTING_DEFAULTS>(key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
    return (await this.get<(typeof SETTING_DEFAULTS)[K]>(key)) ?? SETTING_DEFAULTS[key];
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}

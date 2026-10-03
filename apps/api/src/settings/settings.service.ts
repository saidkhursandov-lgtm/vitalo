import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Business settings editable by admins (table `settings`, JSON values). */
export const SETTING_KEYS = {
  bankTransferDetails: 'bank_transfer_details',
  cardTransferDetails: 'card_transfer_details',
  paymentHint: 'payment_hint',
  productDisclaimer: 'product_disclaimer',
} as const;

export interface LocalizedText {
  ru: string;
  uz: string;
}

export interface CardTransferDetails {
  card_number: string; // digits only
  recipient: string;
}

/** Payment methods paid by a manual transfer and confirmed by a manager ("Я оплатил(а)" flow). */
export const MANUAL_PAYMENT_METHODS = ['card_transfer', 'bank_transfer'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

/** Initial values (also inserted by migration 20261003120000 "add if missing"). Card details are TEST values. */
export const SETTING_DEFAULTS = {
  product_disclaimer: { ru: 'БАД. НЕ ЯВЛЯЕТСЯ ЛЕКАРСТВЕННЫМ СРЕДСТВОМ.', uz: 'BFQ. DORI VOSITASI EMAS.' } as LocalizedText,
  card_transfer_details: { card_number: '8600000000000000', recipient: 'ТЕСТОВЫЙ ПОЛУЧАТЕЛЬ (ТЕСТОВЫЕ ДАННЫЕ)' } as CardTransferDetails,
  payment_hint: {
    ru: 'Переведите сумму заказа на карту, затем нажмите «Я оплатил(а)». После проверки платежа менеджером статус заказа изменится на «Оплачен», и мы начнём сборку.',
    uz: 'Buyurtma summasini kartaga o‘tkazing, so‘ng «To‘ladim» tugmasini bosing. Menejer to‘lovni tekshirgach, buyurtma holati «To‘langan»ga o‘zgaradi va biz yig‘ishni boshlaymiz.',
  } as LocalizedText,
};

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

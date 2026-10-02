import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Business settings editable by admins (table `settings`, JSON values). */
export const SETTING_KEYS = {
  bankTransferDetails: 'bank_transfer_details',
} as const;

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
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}

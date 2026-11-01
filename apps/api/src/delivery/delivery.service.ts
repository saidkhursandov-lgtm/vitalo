import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { DeliveryQuote, firstOrderFree, quoteDelivery, Tariff } from './delivery-quote';

type Db = Prisma.TransactionClient | PrismaService;

/** «г. Ташкент» (the city as a region), not «Ташкентская область». */
export const isTashkentRegionName = (name: string) => /^г\.?\s*ташкент$/i.test(name.trim());

/** Whose order the quote is for (first-order free delivery); exceptOrderId = an existing order being edited. */
export interface QuoteCustomer {
  userId: string;
  exceptOrderId?: string;
}

export interface DaysRange {
  min_days: number;
  max_days: number;
}

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Release 1: the region is the city of Tashkent («Оплата при получении» works only there). */
  async isTashkent(regionId: string, db: Db = this.prisma): Promise<boolean> {
    const region = await db.regions.findUnique({ where: { id: regionId }, select: { name_ru: true } });
    return !!region && isTashkentRegionName(region.name_ru);
  }

  /** Release 1: «Бесплатная доставка первого заказа» is on and this is the customer's first order (hasNoOrders). */
  async isFirstOrder(customer: QuoteCustomer, db: Db = this.prisma): Promise<boolean> {
    if (!(await this.settings.getOrDefault('checkout_options')).first_order_free_delivery) return false;
    return this.hasNoOrders(customer.userId, db, customer.exceptOrderId);
  }

  /**
   * D-39 (В): THE «first order» rule, for free delivery and for «только первый заказ» promo codes — the customer has
   * no order except cancelled ones (unpaid, paid, in delivery and delivered ones all count).
   */
  async hasNoOrders(userId: string, db: Db = this.prisma, exceptOrderId?: string): Promise<boolean> {
    const others = await db.orders.count({ where: { user_id: userId, status: { not: 'cancelled' }, ...(exceptOrderId && { id: { not: exceptOrderId } }) } });
    return others === 0;
  }

  /**
   * For the home page (release 1): from which goods total delivery is free (the region-wide tariff of the city of
   * Tashkent, else the lowest one; never a number written in code) and whether THIS customer's first order is free.
   */
  async freeShippingInfo(userId: string): Promise<{ from_uzs: number | null; first_order_free: boolean }> {
    const rows = await this.prisma.delivery_tariffs.findMany({
      where: { status: 'active', city_id: null, region: { status: 'active' } },
      include: { region: true },
    });
    const tashkent = rows.filter((t) => isTashkentRegionName(t.region.name_ru));
    const pool = tashkent.length ? tashkent : rows;
    const from = pool.length ? Math.min(...pool.map((t) => Number(t.free_shipping_threshold_uzs))) : null;
    return { from_uzs: from, first_order_free: await this.isFirstOrder({ userId }) };
  }

  async listRegions() {
    const regions = await this.prisma.regions.findMany({
      where: { status: 'active' },
      orderBy: { name_ru: 'asc' },
      include: { cities: { where: { status: 'active' }, orderBy: { name_ru: 'asc' } } },
    });
    return regions.map((r) => ({
      id: r.id,
      name_ru: r.name_ru,
      name_uz: r.name_uz,
      cities: r.cities.map((c) => ({ id: c.id, name_ru: c.name_ru, name_uz: c.name_uz })),
    }));
  }

  /** The city must belong to the region and both must be active. */
  async assertCityInRegion(regionId: string, cityId: string, db: Db = this.prisma): Promise<void> {
    const city = await db.cities.findFirst({
      where: { id: cityId, region_id: regionId, status: 'active', region: { status: 'active' } },
    });
    if (!city) throw new BadRequestException({ code: 'INVALID_ADDRESS', message: 'City does not belong to the region' });
  }

  /** City-specific tariff wins over the region default (city_id = NULL). */
  async resolveTariff(regionId: string, cityId: string, db: Db = this.prisma): Promise<Tariff> {
    await this.assertCityInRegion(regionId, cityId, db);

    const tariffs = await db.delivery_tariffs.findMany({
      where: { region_id: regionId, status: 'active', OR: [{ city_id: cityId }, { city_id: null }] },
    });
    const cityTariff = tariffs.find((t) => t.city_id === cityId);
    const regionTariff = tariffs.find((t) => t.city_id === null);
    const tariff = cityTariff ?? regionTariff;
    if (!tariff) {
      throw new UnprocessableEntityException({ code: 'DELIVERY_UNAVAILABLE', message: 'No delivery tariff for this city' });
    }
    // A city without its own term takes the region's one.
    const term = tariff.min_days != null && tariff.max_days != null ? tariff : regionTariff;
    return {
      tariff_uzs: Number(tariff.tariff_uzs),
      free_shipping_threshold_uzs: Number(tariff.free_shipping_threshold_uzs),
      min_days: term?.min_days ?? null,
      max_days: term?.max_days ?? null,
      note_ru: tariff.note_ru ?? regionTariff?.note_ru ?? null,
      note_uz: tariff.note_uz ?? regionTariff?.note_uz ?? null,
    };
  }

  /** Delivery term for one city (product card, order screens); null when there is no tariff. */
  async eta(regionId: string, cityId: string, db: Db = this.prisma): Promise<{ min_days: number | null; max_days: number | null; note_ru: string | null; note_uz: string | null } | null> {
    try {
      const t = await this.resolveTariff(regionId, cityId, db);
      return { min_days: t.min_days ?? null, max_days: t.max_days ?? null, note_ru: t.note_ru ?? null, note_uz: t.note_uz ?? null };
    } catch {
      return null;
    }
  }

  /** General terms for texts like "Ташкент 2-5 дней, регионы 5-10 дней" (from active region-wide tariffs). */
  async terms(): Promise<{ tashkent: DaysRange | null; regions: DaysRange | null }> {
    const rows = await this.prisma.delivery_tariffs.findMany({
      where: { status: 'active', city_id: null, min_days: { not: null }, max_days: { not: null }, region: { status: 'active' } },
      include: { region: true },
    });
    const range = (list: typeof rows): DaysRange | null =>
      list.length ? { min_days: Math.min(...list.map((t) => t.min_days!)), max_days: Math.max(...list.map((t) => t.max_days!)) } : null;
    return { tashkent: range(rows.filter((t) => isTashkentRegionName(t.region.name_ru))), regions: range(rows.filter((t) => !isTashkentRegionName(t.region.name_ru))) };
  }

  /** With a customer: their first order is delivered free when the setting is on (cart, checkout, order edit). */
  async quote(regionId: string, cityId: string, goodsAfterDiscountsUzs: number, db: Db = this.prisma, customer?: QuoteCustomer): Promise<DeliveryQuote> {
    const quote = quoteDelivery(await this.resolveTariff(regionId, cityId, db), goodsAfterDiscountsUzs);
    if (customer && !quote.is_free && (await this.isFirstOrder(customer, db))) return firstOrderFree(quote);
    return quote;
  }
}

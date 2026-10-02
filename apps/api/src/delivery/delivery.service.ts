import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryQuote, quoteDelivery, Tariff } from './delivery-quote';

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class DeliveryService {
  constructor(private readonly prisma: PrismaService) {}

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
    const tariff = tariffs.find((t) => t.city_id === cityId) ?? tariffs.find((t) => t.city_id === null);
    if (!tariff) {
      throw new UnprocessableEntityException({ code: 'DELIVERY_UNAVAILABLE', message: 'No delivery tariff for this city' });
    }
    return { tariff_uzs: Number(tariff.tariff_uzs), free_shipping_threshold_uzs: Number(tariff.free_shipping_threshold_uzs) };
  }

  async quote(regionId: string, cityId: string, goodsAfterDiscountsUzs: number, db: Db = this.prisma): Promise<DeliveryQuote> {
    return quoteDelivery(await this.resolveTariff(regionId, cityId, db), goodsAfterDiscountsUzs);
  }
}

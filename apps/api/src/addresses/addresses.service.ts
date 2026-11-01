import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { addresses, cities, Prisma, regions } from '@prisma/client';
import { DeliveryService } from '../delivery/delivery.service';
import { PrismaService } from '../prisma/prisma.service';
import { AddressDto, UpdateAddressDto } from './addresses.dto';

type Tx = Prisma.TransactionClient;
type AddressRow = addresses & { region: regions; city: cities };

export const MAX_ADDRESSES = 10;
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export function toAddressView(a: AddressRow) {
  return {
    id: a.id,
    label: a.label,
    region: { id: a.region.id, name_ru: a.region.name_ru, name_uz: a.region.name_uz },
    city: { id: a.city.id, name_ru: a.city.name_ru, name_uz: a.city.name_uz },
    address_text: a.address_text,
    latitude: a.latitude == null ? null : Number(a.latitude),
    longitude: a.longitude == null ? null : Number(a.longitude),
    apartment: a.apartment,
    entrance: a.entrance,
    floor: a.floor,
    landmark: a.landmark,
    is_primary: a.is_primary,
    created_at: a.created_at,
  };
}

/**
 * Saved delivery addresses. Exactly one primary per user while any address exists
 * (DB: partial unique index addresses_one_primary). Deleting is soft (deleted_at).
 * Every write locks the user row first, so parallel changes cannot break the "one primary" rule.
 */
@Injectable()
export class AddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: DeliveryService,
  ) {}

  async list(userId: string) {
    const rows = await this.prisma.addresses.findMany({
      where: { user_id: userId, deleted_at: null },
      orderBy: [{ is_primary: 'desc' }, { created_at: 'desc' }],
      include: { region: true, city: true },
    });
    return rows.map(toAddressView);
  }

  async create(userId: string, dto: AddressDto) {
    return this.inUserTx(userId, async (tx) => {
      await this.assertCityInRegion(tx, dto.region_id, dto.city_id);
      const count = await tx.addresses.count({ where: { user_id: userId, deleted_at: null } });
      if (count >= MAX_ADDRESSES) {
        throw new UnprocessableEntityException({ code: 'TOO_MANY_ADDRESSES', message: `At most ${MAX_ADDRESSES} addresses` });
      }
      const makePrimary = count === 0 || dto.is_primary === true; // the first address is always primary
      if (makePrimary) await this.clearPrimary(tx, userId);
      const row = await tx.addresses.create({
        data: {
          user_id: userId,
          label: dto.label ?? null,
          region_id: dto.region_id,
          city_id: dto.city_id,
          address_text: dto.address_text,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          apartment: dto.apartment || null,
          entrance: dto.entrance || null,
          floor: dto.floor || null,
          landmark: dto.landmark || null,
          is_primary: makePrimary,
        },
        include: { region: true, city: true },
      });
      return toAddressView(row);
    });
  }

  async update(userId: string, id: string, dto: UpdateAddressDto) {
    return this.inUserTx(userId, async (tx) => {
      const current = await this.findOwn(tx, userId, id);
      const regionId = dto.region_id ?? current.region_id;
      const cityId = dto.city_id ?? current.city_id;
      if (dto.region_id || dto.city_id) await this.assertCityInRegion(tx, regionId, cityId);
      const row = await tx.addresses.update({
        where: { id },
        data: {
          ...(dto.label !== undefined && { label: dto.label }),
          region_id: regionId,
          city_id: cityId,
          ...(dto.address_text !== undefined && { address_text: dto.address_text }),
          ...(dto.latitude !== undefined && { latitude: dto.latitude }),
          ...(dto.longitude !== undefined && { longitude: dto.longitude }),
          ...(dto.apartment !== undefined && { apartment: dto.apartment || null }),
          ...(dto.entrance !== undefined && { entrance: dto.entrance || null }),
          ...(dto.floor !== undefined && { floor: dto.floor || null }),
          ...(dto.landmark !== undefined && { landmark: dto.landmark || null }),
        },
        include: { region: true, city: true },
      });
      return toAddressView(row);
    });
  }

  async makePrimary(userId: string, id: string) {
    await this.inUserTx(userId, async (tx) => {
      await this.findOwn(tx, userId, id);
      await this.clearPrimary(tx, userId);
      await tx.addresses.update({ where: { id }, data: { is_primary: true } });
    });
    return this.list(userId);
  }

  /** Soft delete. If the primary address is deleted, the newest remaining one becomes primary. */
  async remove(userId: string, id: string) {
    await this.inUserTx(userId, async (tx) => {
      const current = await this.findOwn(tx, userId, id);
      await tx.addresses.update({ where: { id }, data: { deleted_at: new Date(), is_primary: false } });
      if (current.is_primary) {
        const next = await tx.addresses.findFirst({
          where: { user_id: userId, deleted_at: null },
          orderBy: { created_at: 'desc' },
        });
        if (next) await tx.addresses.update({ where: { id: next.id }, data: { is_primary: true } });
      }
    });
    return this.list(userId);
  }

  private inUserTx<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      return fn(tx);
    }, TX_OPTIONS);
  }

  private async findOwn(tx: Tx, userId: string, id: string) {
    const row = await tx.addresses.findFirst({ where: { id, user_id: userId, deleted_at: null } });
    if (!row) throw new NotFoundException('Address not found');
    return row;
  }

  private async clearPrimary(tx: Tx, userId: string) {
    await tx.addresses.updateMany({ where: { user_id: userId, is_primary: true }, data: { is_primary: false } });
  }

  private assertCityInRegion(tx: Tx, regionId: string, cityId: string) {
    return this.delivery.assertCityInRegion(regionId, cityId, tx);
  }
}

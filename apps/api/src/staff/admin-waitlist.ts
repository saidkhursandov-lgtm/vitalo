import { Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { availableQty } from '../catalog/product.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { productTitle } from '../waitlist/waitlist';
import { RequirePermission, StaffGuard } from './staff-auth';

/** 2.4: «Лист ожидания» in the admin panel — products customers wait for and who is waiting (phones: customers.view). */
@Injectable()
export class AdminWaitlistService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every product that has (or had) subscriptions; most waiting first. */
  async products() {
    const groups = await this.prisma.product_waitlist.groupBy({ by: ['product_id', 'notified_at'], _count: { _all: true }, _max: { created_at: true } });
    const ids = [...new Set(groups.map((g) => g.product_id))];
    const products = await this.prisma.products.findMany({ where: { id: { in: ids } }, include: { inventory: true } });
    return products
      .map((p) => {
        const mine = groups.filter((g) => g.product_id === p.id);
        const waiting = mine.filter((g) => !g.notified_at).reduce((s, g) => s + g._count._all, 0);
        const notified = mine.filter((g) => g.notified_at).reduce((s, g) => s + g._count._all, 0);
        const last = mine.reduce<Date | null>((m, g) => (g._max.created_at && (!m || g._max.created_at > m) ? g._max.created_at : m), null);
        return { product_id: p.id, sku: p.sku, name: productTitle(p, 'ru'), status: p.status, available_qty: availableQty(p.inventory), waiting, notified, last_at: last };
      })
      .sort((a, b) => b.waiting - a.waiting || (b.last_at?.getTime() ?? 0) - (a.last_at?.getTime() ?? 0));
  }

  /** Customers of one product: waiting ones first, newest first. */
  async product(productId: string) {
    const p = await this.prisma.products.findUnique({ where: { id: productId }, include: { inventory: true } });
    if (!p) throw new NotFoundException('Product not found');
    const rows = await this.prisma.product_waitlist.findMany({ where: { product_id: productId }, include: { user: true }, orderBy: { created_at: 'desc' } });
    rows.sort((a, b) => Number(!!a.notified_at) - Number(!!b.notified_at));
    return {
      product: { id: p.id, sku: p.sku, name: productTitle(p, 'ru'), available_qty: availableQty(p.inventory) },
      customers: rows.map((r) => ({
        user_id: r.user_id,
        name: [r.user.first_name, r.user.last_name].filter(Boolean).join(' '),
        username: r.user.username,
        telegram_user_id: r.user.telegram_user_id.toString(),
        phone: r.phone ?? r.user.phone,
        created_at: r.created_at,
        notified_at: r.notified_at,
      })),
    };
  }
}

@ApiTags('staff: waitlist')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/waitlist')
export class AdminWaitlistController {
  constructor(private readonly waitlist: AdminWaitlistService) {}

  @Get()
  @RequirePermission('customers.view')
  products() {
    return this.waitlist.products();
  }

  @Get(':productId')
  @RequirePermission('customers.view')
  product(@Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.waitlist.product(productId);
  }
}

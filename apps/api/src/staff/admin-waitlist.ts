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
    const groups = await this.prisma.product_waitlist.groupBy({ by: ['product_id', 'notified_at', 'cancelled_at'], _count: { _all: true }, _max: { created_at: true } });
    const ids = [...new Set(groups.map((g) => g.product_id))];
    const products = await this.prisma.products.findMany({ where: { id: { in: ids } }, include: { inventory: true } });
    // аудит 2.8: «уже едет» — still expected from open purchases (the same count as «Низкие остатки» on the dashboard)
    const incoming = ids.length
      ? await this.prisma.$queryRaw<{ product_id: string; qty: bigint }[]>`
          SELECT l.product_id, SUM(GREATEST(l.ordered_qty - l.cancelled_qty - l.received_qty, 0)) AS qty
          FROM purchase_lines l JOIN purchases pu ON pu.id = l.purchase_id
          WHERE pu.status = 'EXPECTED' AND l.product_id::text = ANY(${ids})
          GROUP BY l.product_id`
      : [];
    return products
      .map((p) => {
        const mine = groups.filter((g) => g.product_id === p.id);
        const sum = (f: (g: (typeof mine)[number]) => boolean) => mine.filter(f).reduce((s, g) => s + g._count._all, 0);
        // only active subscriptions count as waiting; cancelled ones (the bell switched off) are shown apart
        const waiting = sum((g) => !g.notified_at && !g.cancelled_at);
        const notified = sum((g) => !!g.notified_at);
        const cancelled = sum((g) => !g.notified_at && !!g.cancelled_at);
        const last = mine.reduce<Date | null>((m, g) => (g._max.created_at && (!m || g._max.created_at > m) ? g._max.created_at : m), null);
        const coming = Number(incoming.find((i) => i.product_id === p.id)?.qty ?? 0);
        return { product_id: p.id, sku: p.sku, name: productTitle(p, 'ru'), status: p.status, available_qty: availableQty(p.inventory), incoming_qty: coming, waiting, notified, cancelled, last_at: last };
      })
      .sort((a, b) => b.waiting - a.waiting || (b.last_at?.getTime() ?? 0) - (a.last_at?.getTime() ?? 0));
  }

  /** Customers of one product: waiting ones first, then notified, then cancelled; newest first. */
  async product(productId: string) {
    const p = await this.prisma.products.findUnique({ where: { id: productId }, include: { inventory: true } });
    if (!p) throw new NotFoundException('Product not found');
    const rows = await this.prisma.product_waitlist.findMany({ where: { product_id: productId }, include: { user: true }, orderBy: { created_at: 'desc' } });
    const rank = (r: (typeof rows)[number]) => (r.notified_at ? 1 : r.cancelled_at ? 2 : 0);
    rows.sort((a, b) => rank(a) - rank(b));
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
        cancelled_at: r.notified_at ? null : r.cancelled_at,
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

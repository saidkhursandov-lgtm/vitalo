import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { can, type Permission } from './permissions';
import { CurrentStaff, StaffContext, StaffGuard } from './staff-auth';

export class SearchQuery {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q!: string;
}

export interface SearchHit {
  id: string;
  title: string;
  subtitle?: string;
  /** the admin page that opens this hit */
  to: string;
}
export type SearchGroup = 'orders' | 'products' | 'customers' | 'units';

/** How many hits of each kind; the full lists stay on their own pages. */
const LIMIT = 5;

/**
 * Аудит админки 2.10: one search box for the whole admin panel — orders of both channels (number, phone, name),
 * products (SKU, name), customers (phone, name, @username) and jars (Physical ID). Each group only for the
 * employee who may open it (the same permissions as the pages); test records are not hidden — staff look for them too.
 */
@Injectable()
export class AdminSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(text: string, may: (p: Permission) => boolean): Promise<Partial<Record<SearchGroup, SearchHit[]>>> {
    const q = text.trim();
    const digits = q.replace(/\D/g, '');
    const phone = digits.length >= 4 && /^[+\d\s()-]+$/.test(q) ? digits : null;
    const like = { contains: q, mode: 'insensitive' as const };
    const out: Partial<Record<SearchGroup, SearchHit[]>> = {};
    const jobs: Promise<void>[] = [];

    if (may('orders.view') || may('yandex.orders.view')) {
      jobs.push(
        (async () => {
          const hits: SearchHit[] = [];
          if (may('orders.view')) {
            const phoneIds = phone
              ? (
                  await this.prisma.$queryRaw<{ id: string }[]>`
                    SELECT o.id FROM orders o LEFT JOIN users u ON u.id = o.user_id
                    WHERE regexp_replace(o.recipient_phone, '\\D', '', 'g') LIKE ${`%${phone}%`}
                       OR regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') LIKE ${`%${phone}%`}
                    ORDER BY o.created_at DESC LIMIT ${LIMIT}`
                ).map((r) => r.id)
              : [];
            const orders = await this.prisma.orders.findMany({
              where: { OR: [{ order_number: like }, { recipient_name: like }, ...(phoneIds.length ? [{ id: { in: phoneIds } }] : [])] },
              orderBy: { created_at: 'desc' },
              take: LIMIT,
              select: { id: true, order_number: true, recipient_name: true, total_uzs: true },
            });
            hits.push(...orders.map((o) => ({ id: o.id, title: o.order_number, subtitle: `Mini App · ${o.recipient_name}`, to: `/orders/${o.id}` })));
          }
          if (may('yandex.orders.view')) {
            const ya = await this.prisma.marketplace_orders.findMany({
              where: { OR: [{ external_number: like }, { customer_name: like }] },
              orderBy: { created_at: 'desc' },
              take: LIMIT,
              select: { id: true, external_number: true, customer_name: true },
            });
            hits.push(...ya.map((m) => ({ id: m.id, title: m.external_number, subtitle: ['Яндекс Маркет', m.customer_name].filter(Boolean).join(' · '), to: `/yandex-orders/${m.id}` })));
          }
          if (hits.length) out.orders = hits.slice(0, LIMIT * 2);
        })(),
      );
    }

    if (may('products.view')) {
      jobs.push(
        (async () => {
          const products = await this.prisma.products.findMany({
            where: { OR: [{ sku: like }, { name_ru: like }, { name_uz: like }] },
            orderBy: [{ status: 'asc' }, { name_ru: 'asc' }],
            take: LIMIT,
            select: { id: true, sku: true, name_ru: true, status: true },
          });
          if (products.length) out.products = products.map((p) => ({ id: p.id, title: p.name_ru, subtitle: p.status === 'archived' ? `${p.sku} · в архиве` : p.sku, to: `/products/${p.id}` }));
        })(),
      );
    }

    if (may('customers.view')) {
      jobs.push(
        (async () => {
          const phoneIds = phone
            ? (await this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ${`%${phone}%`} LIMIT ${LIMIT}`).map((r) => r.id)
            : [];
          const name = q.replace(/^@/, '');
          const users = await this.prisma.users.findMany({
            where: {
              OR: [{ first_name: like }, { last_name: like }, { username: { contains: name, mode: 'insensitive' } }, ...(phoneIds.length ? [{ id: { in: phoneIds } }] : [])],
            },
            orderBy: { created_at: 'desc' },
            take: LIMIT,
            select: { id: true, first_name: true, last_name: true, username: true, phone: true },
          });
          if (users.length)
            out.customers = users.map((u) => ({
              id: u.id,
              title: [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Без имени',
              subtitle: [u.phone, u.username && `@${u.username}`].filter(Boolean).join(' · ') || undefined,
              to: `/customers/${u.id}`,
            }));
        })(),
      );
    }

    if (may('units.view') && /\d/.test(q)) {
      jobs.push(
        (async () => {
          const units = await this.prisma.physical_units.findMany({
            where: { physical_id: like },
            orderBy: { seq: 'desc' },
            take: LIMIT,
            select: { id: true, physical_id: true, status: true, product: { select: { sku: true, name_ru: true } } },
          });
          if (units.length)
            out.units = units.map((u) => ({ id: u.id, title: u.physical_id, subtitle: `${u.product.sku} · ${u.product.name_ru}`, to: `/inventory?tab=units&code=${encodeURIComponent(u.physical_id)}` }));
        })(),
      );
    }

    await Promise.all(jobs);
    return out;
  }
}

@ApiTags('staff: search')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/search')
export class AdminSearchController {
  constructor(private readonly search: AdminSearchService) {}

  /** Every employee may search; each group is filtered by their own permissions. */
  @Get()
  find(@CurrentStaff() me: StaffContext, @Query() q: SearchQuery) {
    return this.search.search(q.q, (p) => can(me.staff.role, p));
  }
}

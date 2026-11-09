import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { tashkentDateString } from '../common/tashkent';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { DOSE_PER, DOSE_UNITS, normalizeMatchForm } from './iherb-fields';
import { matchOneToOne, PLATFORM_LABELS, PLATFORMS, type MatchResult, type MatchValues, type Platform } from './one-to-one';

type Db = Prisma.TransactionClient | PrismaService;

const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class CompetitorPriceInput {
  @ApiProperty({ enum: PLATFORMS }) @IsIn([...PLATFORMS]) platform!: Platform;
  @ApiPropertyOptional({ nullable: true, description: 'Магазин / аптека' }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(120) seller?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Название у конкурента' }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(300) title?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(500) url?: string | null;
  @ApiProperty({ description: 'Цена, сум' }) @IsInt() @Min(1000) @Max(1_000_000_000) price_uzs!: number;
  @ApiPropertyOptional({ description: 'Когда видели цену (YYYY-MM-DD), по умолчанию сегодня' }) @IsOptional() @IsDateString({ strict: true }) observed_on?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(120) brand?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(80) match_form?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false }) @Min(0) @Max(100000000) dose_amount?: number | null;
  @ApiPropertyOptional({ nullable: true, enum: DOSE_UNITS }) @IsOptional() @IsIn([...DOSE_UNITS, null]) dose_unit?: string | null;
  @ApiPropertyOptional({ nullable: true, enum: DOSE_PER }) @IsOptional() @IsIn([...DOSE_PER, null]) dose_per?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(100000) pack_count?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Сколько заказов / продаж показывает конкурент (Uzum)' }) @IsOptional() @IsInt() @Min(0) @Max(100_000_000) orders_count?: number | null;
}

export class CompetitorListQuery {
  @ApiProperty() @IsUUID() product_id!: string;
}

const PRODUCT_MATCH = { id: true, brand: true, match_form: true, dose_amount: true, dose_unit: true, dose_per: true, pack_count: true } as const;

type ProductMatchRow = { brand: string; match_form: string | null; dose_amount: Prisma.Decimal | null; dose_unit: string | null; dose_per: string | null; pack_count: number | null };
type CompetitorRow = Awaited<ReturnType<PrismaService['competitor_prices']['findFirstOrThrow']>>;

export const productValues = (p: ProductMatchRow): MatchValues => ({
  brand: p.brand,
  match_form: p.match_form,
  dose_amount: p.dose_amount == null ? null : Number(p.dose_amount),
  dose_unit: p.dose_unit,
  dose_per: p.dose_per,
  pack_count: p.pack_count,
});

const competitorValues = (c: Pick<CompetitorRow, 'brand' | 'match_form' | 'dose_amount' | 'dose_unit' | 'dose_per' | 'pack_count'>): MatchValues => ({
  brand: c.brand,
  match_form: c.match_form,
  dose_amount: c.dose_amount == null ? null : Number(c.dose_amount),
  dose_unit: c.dose_unit,
  dose_per: c.dose_per,
  pack_count: c.pack_count,
});

/** A row for the admin panel; the match is checked against the product as it is now (its fields may have been fixed). */
function view(c: CompetitorRow, now: MatchResult) {
  return {
    id: c.id,
    platform: c.platform,
    seller: c.seller,
    title: c.title,
    url: c.url,
    price_uzs: Number(c.price_uzs),
    observed_on: c.observed_on.toISOString().slice(0, 10),
    brand: c.brand,
    match_form: c.match_form,
    dose_amount: c.dose_amount == null ? null : Number(c.dose_amount),
    dose_unit: c.dose_unit,
    dose_per: c.dose_per,
    pack_count: c.pack_count,
    orders_count: c.orders_count,
    source: c.source,
    created_at: c.created_at,
    match_status: now.status,
    mismatch_reasons: now.reasons,
  };
}

export type CompetitorView = ReturnType<typeof view>;

/**
 * The competitors that passed «1-в-1» now, seen in the last `days` days, per product (newest first). Used for the
 * market minimum, the bars and the chart points; rows hidden by «Убрать» and «не тот товар» never count.
 */
export async function matchedCompetitors(db: Db, productIds: string[], days: number): Promise<Map<string, CompetitorView[]>> {
  const out = new Map<string, CompetitorView[]>();
  if (!productIds.length) return out;
  const since = new Date(`${tashkentDateString(new Date(Date.now() - days * 86400_000))}T00:00:00Z`);
  const [products, rows] = await Promise.all([
    db.products.findMany({ where: { id: { in: productIds } }, select: PRODUCT_MATCH }),
    db.competitor_prices.findMany({ where: { product_id: { in: productIds }, hidden_at: null, observed_on: { gte: since } }, orderBy: [{ observed_on: 'desc' }, { created_at: 'desc' }] }),
  ]);
  for (const r of rows) {
    const p = products.find((x) => x.id === r.product_id);
    if (!p) continue;
    const m = matchOneToOne(productValues(p), competitorValues(r));
    if (m.status !== 'match') continue;
    out.set(r.product_id, [...(out.get(r.product_id) ?? []), view(r, m)]);
  }
  return out;
}

/**
 * The newest matched price of each seller — the bars (owner, 09.11: every shop is its own bar, Fitvibe and BioBox on
 * «Другое» are two bars). A row without a shop name is its own seller per platform.
 */
export function latestPerSeller(rows: CompetitorView[]): CompetitorView[] {
  const seen = new Set<string>();
  const key = (r: CompetitorView) => `${r.platform}|${(r.seller ?? '').trim().toLowerCase()}`;
  return rows.filter((r) => (seen.has(key(r)) ? false : (seen.add(key(r)), true)));
}

/** «Fitvibe (Instagram / Telegram)» — where the lowest price is, for the purchase signal. */
export const whereText = (r: Pick<CompetitorView, 'platform' | 'seller'>) =>
  r.seller ? `${r.seller} (${PLATFORM_LABELS[r.platform as Platform] ?? r.platform})` : (PLATFORM_LABELS[r.platform as Platform] ?? r.platform);

@Injectable()
export class CompetitorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async product(db: Db, id: string) {
    const p = await db.products.findUnique({ where: { id }, select: PRODUCT_MATCH });
    if (!p) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Товар не найден' });
    return p;
  }

  /** All rows of a product (hidden ones are not shown), newest first, each with the match against the product now. */
  async list(productId: string) {
    const p = await this.product(this.prisma, productId);
    const rows = await this.prisma.competitor_prices.findMany({ where: { product_id: productId, hidden_at: null }, orderBy: [{ observed_on: 'desc' }, { created_at: 'desc' }], take: 200 });
    return {
      product: { id: p.id, ...productValues(p) },
      items: rows.map((r) => view(r, matchOneToOne(productValues(p), competitorValues(r)))),
    };
  }

  async add(staffId: string, productId: string, d: CompetitorPriceInput, source: 'manual' | 'ai' = 'manual') {
    if (d.dose_amount != null && (!d.dose_unit || !d.dose_per)) {
      throw new BadRequestException({ code: 'DOSE_INCOMPLETE', message: 'У дозы укажите единицу и «на что» (капсула, порция…)' });
    }
    const today = tashkentDateString(new Date());
    if (d.observed_on && d.observed_on > today) throw new BadRequestException({ code: 'DATE_IN_FUTURE', message: 'Дата не может быть позже сегодняшней' });
    return this.prisma.$transaction((tx) => this.addTx(tx, staffId, productId, d, source));
  }

  /** The same inside the caller's transaction (the AI analyst saves several rows at once). Checks are the caller's. */
  async addTx(tx: Prisma.TransactionClient, staffId: string, productId: string, d: CompetitorPriceInput, source: 'manual' | 'ai') {
    const today = tashkentDateString(new Date());
    {
      const p = await this.product(tx, productId);
      const values: MatchValues = {
        brand: d.brand ?? null,
        match_form: d.match_form ? normalizeMatchForm(d.match_form) : null,
        dose_amount: d.dose_amount ?? null,
        dose_unit: d.dose_unit ?? null,
        dose_per: d.dose_per ?? null,
        pack_count: d.pack_count ?? null,
      };
      const m = matchOneToOne(productValues(p), values);
      const row = await tx.competitor_prices.create({
        data: {
          product_id: productId,
          platform: d.platform,
          seller: d.seller ?? null,
          title: d.title ?? null,
          url: d.url ?? null,
          price_uzs: BigInt(d.price_uzs),
          observed_on: new Date(`${d.observed_on ?? today}T00:00:00Z`),
          ...values,
          orders_count: d.orders_count ?? null,
          match_status: m.status,
          mismatch_reasons: m.reasons,
          source,
          staff_user_id: staffId,
        },
      });
      await this.audit.log({ staffId, action: 'competitor_price.added', entityType: 'product', entityId: productId, after: { ...row, price_uzs: d.price_uzs } }, tx);
      return view(row, m);
    }
  }

  /** «Убрать»: the row is hidden, never deleted (it stays in the audit log and the database). */
  async hide(staffId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.competitor_prices.findUnique({ where: { id } });
      if (!row || row.hidden_at) throw new NotFoundException({ code: 'COMPETITOR_PRICE_NOT_FOUND', message: 'Запись не найдена' });
      await tx.competitor_prices.update({ where: { id }, data: { hidden_at: new Date() } });
      await this.audit.log({ staffId, action: 'competitor_price.hidden', entityType: 'product', entityId: row.product_id, before: { id, platform: row.platform, price_uzs: row.price_uzs } }, tx);
      return { id, hidden: true };
    });
  }
}

/** Competitor prices (admin only, like the purchase costs and margins they are compared with). */
@ApiTags('staff: competitors')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/competitors')
export class CompetitorsController {
  constructor(private readonly competitors: CompetitorsService) {}

  @Get()
  @RequirePermission('competitors.manage')
  list(@Query() q: CompetitorListQuery) {
    return this.competitors.list(q.product_id);
  }

  @Post(':productId')
  @RequirePermission('competitors.manage')
  add(@CurrentStaff() me: StaffContext, @Param('productId', new ParseUUIDPipe()) productId: string, @Body() dto: CompetitorPriceInput) {
    return this.competitors.add(me.staff.id, productId, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermission('competitors.manage')
  hide(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.competitors.hide(me.staff.id, id);
  }
}

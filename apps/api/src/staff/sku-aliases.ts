import { Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsIn, IsString, ValidateBy } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Alternative SKUs (aliases) of a product: old codes on Yandex Market (`yandex`) or our old SKUs TPRD-… (`internal`).
 * Unique for the whole catalog ignoring case, never equal to a product SKU (also guarded by triggers).
 */
export const ALIAS_SOURCES = ['yandex', 'internal'] as const;
export type AliasSource = (typeof ALIAS_SOURCES)[number];

/** Length of an alternative SKU (the database CHECK of the aliases table: 2–64 after trimming). */
export const ALIAS_MIN = 2;
export const ALIAS_MAX = 64;

/**
 * Why a text is not a code (null = it is one): only latin letters, digits and . _ / - , no spaces, ALIAS_MIN–ALIAS_MAX
 * characters, at least one letter or digit. Letters-only codes (MRKT-VNQUDOHD) are fine. The text is checked as is
 * (callers trim it first). Used for alternative SKUs (admin card and the xlsx import); product SKUs have their own rule.
 */
export function skuProblem(text: string): string | null {
  if (!text) return 'пустое значение';
  if (/\s/.test(text)) return 'есть пробел — код пишется без пробелов';
  if (/[А-Яа-яЁё]/.test(text)) return 'есть кириллица — буквы должны быть латинские';
  const bad = text.match(/[^A-Za-z0-9._/-]/);
  if (bad) return `недопустимый символ «${bad[0]}» — можно только латиницу, цифры и . _ / -`;
  if (!/[A-Za-z0-9]/.test(text)) return 'нет ни одной буквы или цифры';
  if (text.length < ALIAS_MIN) return `короче ${ALIAS_MIN} символов`;
  if (text.length > ALIAS_MAX) return `длиннее ${ALIAS_MAX} символов`;
  return null;
}

export const isSkuLike = (text: string) => skuProblem(text) === null;

/** class-validator: the alias with the real reason in the error message. */
const IsSkuLike = () =>
  ValidateBy({
    name: 'isSkuLike',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && isSkuLike(value),
      defaultMessage: (args) => `Это не похоже на SKU: ${typeof args?.value === 'string' ? skuProblem(args.value) : 'нужен текст'}`,
    },
  });
export const normSku = (s: string) => s.trim().toUpperCase();

export interface ResolvedProduct {
  id: string;
  sku: string;
  unit_tracking: boolean;
  yandex_price_uzs: bigint | null;
  /** found by an alternative SKU (the old code that matched) */
  alias: string | null;
}

/**
 * Products for the given codes: first by the SKU itself (exactly, as before), then by an alias (case ignored).
 * Codes found nowhere are missing from the map.
 */
export async function findProductsBySkus(db: Db, codes: string[]): Promise<Map<string, ResolvedProduct>> {
  const select = { id: true, sku: true, unit_tracking: true, yandex_price_uzs: true } as const;
  const result = new Map<string, ResolvedProduct>();
  const unique = [...new Set(codes)];
  for (const p of await db.products.findMany({ where: { sku: { in: unique } }, select })) result.set(p.sku, { ...p, alias: null });
  const rest = unique.filter((c) => !result.has(c));
  if (rest.length) {
    const aliases = await db.product_sku_aliases.findMany({ where: { alias_norm: { in: rest.map(normSku) } }, include: { product: { select } } });
    for (const code of rest) {
      const a = aliases.find((x) => x.alias_norm === normSku(code));
      if (a) result.set(code, { ...a.product, alias: a.alias });
    }
  }
  return result;
}

/** Why an alias cannot be added (null = fine): a product SKU, or an alias of this or another product. */
export async function aliasConflict(db: Db, productId: string, alias: string): Promise<{ code: string; message: string } | null> {
  const norm = normSku(alias);
  const [bySku] = await db.$queryRaw<{ id: string; sku: string }[]>`SELECT id, sku FROM products WHERE upper(btrim(sku)) = ${norm} LIMIT 1`;
  if (bySku) {
    return bySku.id === productId
      ? { code: 'ALIAS_IS_OWN_SKU', message: `${alias} — это SKU самого товара` }
      : { code: 'ALIAS_IS_SKU', message: `${alias} — SKU другого товара (${bySku.sku})` };
  }
  const existing = await db.product_sku_aliases.findUnique({ where: { alias_norm: norm }, include: { product: { select: { sku: true } } } });
  if (existing) {
    return existing.product_id === productId
      ? { code: 'ALIAS_EXISTS', message: `${alias} уже есть у этого товара` }
      : { code: 'ALIAS_TAKEN', message: `${alias} уже альтернативный SKU товара ${existing.product.sku}` };
  }
  return null;
}

export class AddAliasDto {
  @ApiProperty({ example: 'TPRD-031' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsSkuLike()
  alias!: string;

  @ApiProperty({ enum: ALIAS_SOURCES }) @IsIn([...ALIAS_SOURCES]) source!: AliasSource;
}

@Injectable()
export class SkuAliasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(productId: string) {
    await this.product(this.prisma, productId);
    const rows = await this.prisma.product_sku_aliases.findMany({ where: { product_id: productId }, orderBy: { created_at: 'asc' } });
    return rows.map(({ id, alias, source, created_at }) => ({ id, alias, source, created_at }));
  }

  /** Admin: add an alias (conflicts checked under a lock on the alias), audit «product.alias_added». */
  async add(staffId: string | null, productId: string, dto: AddAliasDto, db?: Prisma.TransactionClient) {
    const run = async (tx: Prisma.TransactionClient) => {
      const product = await this.product(tx, productId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sku-alias:${normSku(dto.alias)}`}))`;
      const conflict = await aliasConflict(tx, productId, dto.alias);
      if (conflict) throw new ConflictException(conflict);
      const row = await tx.product_sku_aliases.create({ data: { product_id: productId, alias: dto.alias, alias_norm: normSku(dto.alias), source: dto.source, created_by: staffId } });
      await this.audit.log({ staffId, action: 'product.alias_added', entityType: 'product', entityId: productId, after: { sku: product.sku, alias: row.alias, source: row.source } }, tx);
      return { id: row.id, alias: row.alias, source: row.source, created_at: row.created_at };
    };
    return db ? run(db) : this.prisma.$transaction(run);
  }

  /** Admin: remove an alias, audit «product.alias_removed» (what it was). */
  async remove(staffId: string, productId: string, aliasId: string) {
    return this.prisma.$transaction(async (tx) => {
      const product = await this.product(tx, productId);
      const row = await tx.product_sku_aliases.findFirst({ where: { id: aliasId, product_id: productId } });
      if (!row) throw new NotFoundException({ code: 'ALIAS_NOT_FOUND', message: 'Альтернативный SKU не найден' });
      await tx.product_sku_aliases.delete({ where: { id: row.id } });
      await this.audit.log({ staffId, action: 'product.alias_removed', entityType: 'product', entityId: productId, before: { sku: product.sku, alias: row.alias, source: row.source } }, tx);
      return { id: row.id, removed: true };
    });
  }

  private async product(db: Db, id: string) {
    const p = await db.products.findUnique({ where: { id }, select: { id: true, sku: true } });
    if (!p) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Товар не найден' });
    return p;
  }
}

@ApiTags('staff: products')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/products/:id/aliases')
export class SkuAliasesController {
  constructor(private readonly aliases: SkuAliasesService) {}

  @Get()
  @RequirePermission('products.view')
  list(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.aliases.list(id);
  }

  @Post()
  @RequirePermission('products.aliases')
  add(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AddAliasDto) {
    return this.aliases.add(me.staff.id, id, dto);
  }

  @Delete(':aliasId')
  @RequirePermission('products.aliases')
  remove(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('aliasId', new ParseUUIDPipe()) aliasId: string) {
    return this.aliases.remove(me.staff.id, id, aliasId);
  }
}

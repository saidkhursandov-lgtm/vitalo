import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { EntityStatus, Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { SUPPLIER_KINDS, type SupplierKind } from '../orders/cross-border';
import { cleanName, DICTIONARY_COLUMNS, DICTIONARY_KINDS, DictionaryKind, matchKey } from '../dictionaries/dictionary-names';
import { uniqueSlug } from '../catalog/brand-names';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

type Db = Prisma.TransactionClient | PrismaService;

/** Stage 2A: dictionaries of purchases. Same rules as the product ones; the name column is `name`. */
export const PURCHASE_DICTIONARY_KINDS = ['suppliers', 'ozon_accounts'] as const;
export type PurchaseDictionaryKind = (typeof PURCHASE_DICTIONARY_KINDS)[number];
export type AnyDictionaryKind = DictionaryKind | PurchaseDictionaryKind;
const ALL_KINDS: readonly string[] = [...DICTIONARY_KINDS, ...PURCHASE_DICTIONARY_KINDS];
const isPurchaseKind = (k: AnyDictionaryKind): k is PurchaseDictionaryKind => (PURCHASE_DICTIONARY_KINDS as readonly string[]).includes(k);
const LABEL: Record<AnyDictionaryKind, string> = {
  ...(Object.fromEntries(DICTIONARY_KINDS.map((k) => [k, DICTIONARY_COLUMNS[k].label])) as Record<DictionaryKind, string>),
  suppliers: 'поставщик',
  ozon_accounts: 'Ozon-аккаунт',
};

export interface DictionaryRow {
  id: string;
  name_ru: string;
  name_uz: string | null;
  status: EntityStatus;
  created_at: Date;
  updated_at: Date;
}

/** The four product dictionary tables have the same columns; this is the part of their Prisma delegates used here. */
interface DictionaryTable {
  findMany(args?: object): Promise<(DictionaryRow & { _count?: { products: number } })[]>;
  findUnique(args: { where: { id: string } }): Promise<DictionaryRow | null>;
  create(args: { data: { name_ru: string; name_uz?: string | null; slug?: string } }): Promise<DictionaryRow>;
  update(args: { where: { id: string }; data: Partial<Pick<DictionaryRow, 'name_ru' | 'name_uz' | 'status'>> }): Promise<DictionaryRow>;
}

export const dictionaryTable = (db: Db, kind: DictionaryKind) => db[kind] as unknown as DictionaryTable;

/** Any of the six tables (product dictionaries: name_ru / name_uz; purchase ones: name / note). */
interface AnyRow {
  id: string;
  name_ru?: string;
  name?: string;
  name_uz?: string | null;
  note?: string | null;
  status: EntityStatus;
  _count?: { products?: number; purchases?: number };
}
interface AnyTable {
  findMany(args?: object): Promise<AnyRow[]>;
  findUnique(args: { where: { id: string } }): Promise<AnyRow | null>;
  create(args: { data: object }): Promise<AnyRow>;
  update(args: { where: { id: string }; data: object }): Promise<AnyRow>;
}
const anyTable = (db: Db, kind: AnyDictionaryKind) => db[kind] as unknown as AnyTable;
const nameOf = (r: AnyRow) => r.name_ru ?? r.name ?? '';

/** Same value already there (case, spaces, ё/е ignored)? Archived values count too: they are restored, not duplicated. */
async function findSame(db: Db, kind: AnyDictionaryKind, name: string, exceptId?: string) {
  const key = matchKey(name);
  return (await anyTable(db, kind).findMany()).find((r) => r.id !== exceptId && matchKey(nameOf(r)) === key) ?? null;
}

function duplicate(kind: AnyDictionaryKind, row: AnyRow) {
  return new ConflictException({
    code: 'DICTIONARY_DUPLICATE',
    message: `«${nameOf(row)}» уже есть (${LABEL[kind]}${row.status === 'archived' ? ', в архиве' : ''})`,
    existing: { id: row.id, name_ru: nameOf(row), status: row.status },
  });
}

/**
 * Value by name, created when missing (import / backfill). Returns the stored row and whether it was created.
 * Matching ignores case, spaces and ё/е, so «Эвалар» and «ЭВАЛАР » are one value.
 */
export async function ensureDictionaryValue(
  db: Db,
  audit: AuditService,
  kind: DictionaryKind,
  name: string,
  staffId: string | null,
): Promise<{ row: DictionaryRow; created: boolean }> {
  const same = (await findSame(db, kind, name)) as DictionaryRow | null;
  if (same) return { row: same, created: false };
  const row = await dictionaryTable(db, kind).create({ data: { name_ru: cleanName(name), ...(kind === 'brands' && { slug: await freeBrandSlug(db, name) }) } });
  await audit.log({ staffId, action: 'dictionary.created', entityType: kind, entityId: row.id, after: row }, db);
  return { row, created: true };
}

/** 2.2: every new brand gets its page address at once («NOW Foods» -> now-foods). */
export async function freeBrandSlug(db: Db, name: string): Promise<string> {
  const taken = new Set((await db.brands.findMany({ where: { slug: { not: null } }, select: { slug: true } })).map((b) => b.slug!));
  return uniqueSlug(name, taken);
}

const clean = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanName(value) : value);
const cleanOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanName(value) || null : value);

/** D-61: what a supplier is — Ozon (stock only), local (Tashkent) or foreign — «из США», its terms and its tab order. */
class SupplierFields {
  @ApiPropertyOptional({ enum: SUPPLIER_KINDS, description: 'Только поставщики: ozon — на склад; local — местный; foreign — из-за рубежа' })
  @IsOptional() @IsIn(SUPPLIER_KINDS) kind?: SupplierKind;
  @ApiPropertyOptional({ nullable: true, description: 'Только зарубежные: «из США»' }) @IsOptional() @Transform(cleanOrNull) @IsString() @MaxLength(40) from_ru?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Только зарубежные: «AQShdan»' }) @IsOptional() @Transform(cleanOrNull) @IsString() @MaxLength(40) from_uz?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Под заказ: от, дней (пусто — 1 местный / 7 зарубежный)' }) @IsOptional() @IsInt() @Min(1) @Max(120) days_min?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Под заказ: до, дней (пусто — 2 / 14)' }) @IsOptional() @IsInt() @Min(1) @Max(120) days_max?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Гарантия: можно отменить, если товара нет к этому дню (пусто — 7 / 21)' }) @IsOptional() @IsInt() @Min(1) @Max(180) guarantee_days?: number | null;
  @ApiPropertyOptional({ description: 'Порядок вкладки' }) @IsOptional() @IsInt() @Min(0) @Max(10000) sort?: number;
}
const SUPPLIER_FIELDS = ['kind', 'from_ru', 'from_uz', 'days_min', 'days_max', 'guarantee_days', 'sort'] as const;

/** name_ru is «the name» of every dictionary (suppliers and Ozon accounts store it as `name`). */
export class DictionaryInput extends SupplierFields {
  @ApiProperty({ example: 'Эвалар' }) @Transform(clean) @IsString() @IsNotEmpty() @MaxLength(200) name_ru!: string;
  @ApiPropertyOptional({ nullable: true, description: 'Только бренды, производители, страны, формы' })
  @IsOptional()
  @Transform(cleanOrNull)
  @IsString()
  @MaxLength(200)
  name_uz?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Только поставщики: заметка' })
  @IsOptional()
  @Transform(cleanOrNull)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class DictionaryPatch extends SupplierFields {
  @ApiPropertyOptional() @IsOptional() @Transform(clean) @IsString() @IsNotEmpty() @MaxLength(200) name_ru?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(cleanOrNull) @IsString() @MaxLength(200) name_uz?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(cleanOrNull) @IsString() @MaxLength(1000) note?: string | null;
  @ApiPropertyOptional({ enum: EntityStatus }) @IsOptional() @IsEnum(EntityStatus) status?: EntityStatus;
}

export class DictionaryQuery {
  @ApiPropertyOptional({ description: 'true — вместе с архивными' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  include_archived?: boolean;
  @ApiPropertyOptional({ description: 'D-61: только бренды — те, у которых есть товары этого поставщика' })
  @IsOptional() @IsUUID() supplier_id?: string;
}

/** D-61: the supplier columns sent (undefined — unchanged); «из …» only for a foreign one. */
function supplierData(dto: SupplierFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SUPPLIER_FIELDS) if (dto[f] !== undefined) out[f] = dto[f];
  if (out.kind && out.kind !== 'foreign') Object.assign(out, { from_ru: null, from_uz: null });
  return out;
}

/** One shape for the admin screen: `products` = how many products (or purchases) use the value. */
const toView = (kind: AnyDictionaryKind, r: AnyRow) => ({
  id: r.id,
  name_ru: nameOf(r),
  name_uz: isPurchaseKind(kind) ? null : (r.name_uz ?? null),
  status: r.status,
  products: kind === 'suppliers' ? (r._count?.purchases ?? 0) : (r._count?.products ?? r._count?.purchases ?? 0),
  ...(kind === 'suppliers' && {
    note: r.note ?? null,
    ...Object.fromEntries(SUPPLIER_FIELDS.map((f) => [f, (r as unknown as Record<string, unknown>)[f] ?? null])),
    code: (r as unknown as { code?: string | null }).code ?? null,
    /** D-61: products bought from it (`products` stays the number of purchases) */
    product_count: r._count?.products ?? 0,
  }),
});

/** Stage 1.1 + 2A.1: brands / manufacturers / countries / forms / suppliers / Ozon accounts. Never deleted, only archived. */
@Injectable()
export class AdminDictionariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(kind: AnyDictionaryKind, includeArchived = false, supplierId?: string) {
    // D-61: the brands tab of a supplier — brands with its products, the count of those products
    const bySupplier = kind === 'brands' && supplierId ? { suppliers: { some: { supplier_id: supplierId } } } : null;
    const rows = await anyTable(this.prisma, kind).findMany({
      where: { ...(includeArchived ? {} : { status: 'active' }), ...(bySupplier && { products: { some: bySupplier } }) },
      orderBy: [{ status: 'asc' }, ...(kind === 'suppliers' ? [{ sort: 'asc' }] : []), { [isPurchaseKind(kind) ? 'name' : 'name_ru']: 'asc' }],
      include: {
        _count: {
          select:
            kind === 'suppliers'
              ? { purchases: true, products: true }
              : { [isPurchaseKind(kind) ? 'purchases' : 'products']: bySupplier ? { where: bySupplier } : true },
        },
      },
    });
    return rows.map((r) => toView(kind, r));
  }

  async create(staffId: string, kind: AnyDictionaryKind, dto: DictionaryInput) {
    return this.write(kind, async (tx) => {
      const same = await findSame(tx, kind, dto.name_ru);
      if (same) throw duplicate(kind, same);
      const data = isPurchaseKind(kind)
        ? { name: dto.name_ru, ...(kind === 'suppliers' && { note: dto.note ?? null, ...supplierData(dto) }) }
        : { name_ru: dto.name_ru, name_uz: dto.name_uz ?? null, ...(kind === 'brands' && { slug: await freeBrandSlug(tx, dto.name_ru) }) };
      const row = await anyTable(tx, kind).create({ data });
      await this.audit.log({ staffId, action: 'dictionary.created', entityType: kind, entityId: row.id, after: row }, tx);
      return toView(kind, row);
    });
  }

  /**
   * Rename and/or archive. A new name of a product dictionary value is copied into the text column of every
   * product linked to it (the Mini App reads that column), in the same transaction, with one audit entry.
   */
  async update(staffId: string, kind: AnyDictionaryKind, id: string, dto: DictionaryPatch) {
    return this.write(kind, async (tx) => {
      const before = await anyTable(tx, kind).findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Dictionary value not found');
      const purchaseKind = isPurchaseKind(kind);
      const rename = dto.name_ru !== undefined && dto.name_ru !== nameOf(before);
      if (rename) {
        const same = await findSame(tx, kind, dto.name_ru!, id);
        if (same) throw duplicate(kind, same);
      }
      const data: Record<string, unknown> = {};
      if (rename) data[purchaseKind ? 'name' : 'name_ru'] = dto.name_ru;
      if (!purchaseKind && dto.name_uz !== undefined && dto.name_uz !== before.name_uz) data.name_uz = dto.name_uz;
      if (kind === 'suppliers' && dto.note !== undefined && dto.note !== before.note) data.note = dto.note;
      if (kind === 'suppliers') {
        for (const [k, v] of Object.entries(supplierData(dto))) if (v !== (before as unknown as Record<string, unknown>)[k]) data[k] = v;
        const kindNow = (data.kind ?? (before as unknown as { kind: string }).kind) as string;
        const code = (before as unknown as { code: string | null }).code;
        // the built-in ones keep their kind: Ozon is the stock, iHerb is abroad
        if (data.kind && code && data.kind !== (code === 'ozon' ? 'ozon' : 'foreign')) {
          throw new BadRequestException({ code: 'SUPPLIER_KIND_FIXED', message: 'Тип Ozon и iHerb не меняется' });
        }
        if (kindNow === 'ozon' && data.kind) {
          // Ozon cannot be «под заказ»: products using a supplier turned into Ozon lose that choice
          await tx.products.updateMany({ where: { on_zero_supplier_id: id }, data: { on_zero_supplier_id: null } });
        }
      }
      if (dto.status !== undefined && dto.status !== before.status) data.status = dto.status;
      if (!Object.keys(data).length) return toView(kind, before);
      if (kind === 'suppliers') {
        const after = { ...before, ...data } as unknown as { days_min: number | null; days_max: number | null; guarantee_days: number | null };
        if (after.days_min && after.days_max && after.days_max < after.days_min) throw new BadRequestException({ code: 'BAD_TERMS', message: '«До» не может быть меньше «от»' });
        if (after.days_max && after.guarantee_days && after.guarantee_days < after.days_max) throw new BadRequestException({ code: 'BAD_TERMS', message: 'Гарантия не может быть короче срока «до»' });
      }

      const after = await anyTable(tx, kind).update({ where: { id }, data });
      let productsUpdated = 0;
      if (rename && !purchaseKind) {
        const cols = DICTIONARY_COLUMNS[kind as DictionaryKind];
        productsUpdated = (await tx.products.updateMany({ where: { [cols.id]: id }, data: { [cols.text]: dto.name_ru } })).count;
      }
      const action = rename ? 'dictionary.renamed' : data.status === 'archived' ? 'dictionary.archived' : data.status === 'active' ? 'dictionary.restored' : 'dictionary.updated';
      await this.audit.log({ staffId, action, entityType: kind, entityId: id, before, after: { ...after, products_updated: productsUpdated } }, tx);
      return { ...toView(kind, after), products_updated: productsUpdated };
    });
  }

  private async write<T>(kind: AnyDictionaryKind, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (e) {
      // Two admins adding the same name at once: the unique index answers, not a 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'DICTIONARY_DUPLICATE', message: `Такое значение уже есть (${LABEL[kind]})` });
      }
      throw e;
    }
  }
}

function kindOf(raw: string): AnyDictionaryKind {
  if (!ALL_KINDS.includes(raw)) {
    throw new BadRequestException({ code: 'UNKNOWN_DICTIONARY', message: 'brands, manufacturers, countries, forms, suppliers or ozon_accounts' });
  }
  return raw as AnyDictionaryKind;
}

@ApiTags('staff: dictionaries')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/dictionaries')
export class AdminDictionariesController {
  constructor(private readonly dictionaries: AdminDictionariesService) {}

  /** The product card shows product dictionaries to everyone who may open it; purchase ones go with purchases. */
  @Get(':kind')
  @RequirePermission('products.view', 'settings.dictionaries', 'purchases.view')
  async list(@CurrentStaff() me: StaffContext, @Param('kind') raw: string, @Query() q: DictionaryQuery) {
    const kind = kindOf(raw);
    const role = me.staff.role;
    // D-61: suppliers are also the tabs of «Товары» and «Бренды» — anyone who sees products sees their names
    if (kind === 'ozon_accounts' && !can(role, 'purchases.view') && !can(role, 'settings.dictionaries')) {
      throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: `Role ${role} cannot see ${kind}` });
    }
    const rows = await this.dictionaries.list(kind, q.include_archived, q.supplier_id);
    // the notes (contacts, terms) stay with purchases
    if (kind === 'suppliers' && !can(role, 'purchases.view') && !can(role, 'settings.dictionaries')) return rows.map((r) => ({ ...r, note: null }));
    return rows;
  }

  @Post(':kind')
  @RequirePermission('settings.dictionaries')
  create(@CurrentStaff() me: StaffContext, @Param('kind') kind: string, @Body() dto: DictionaryInput) {
    return this.dictionaries.create(me.staff.id, kindOf(kind), dto);
  }

  @Patch(':kind/:id')
  @RequirePermission('settings.dictionaries')
  update(@CurrentStaff() me: StaffContext, @Param('kind') kind: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: DictionaryPatch) {
    return this.dictionaries.update(me.staff.id, kindOf(kind), id, dto);
  }
}

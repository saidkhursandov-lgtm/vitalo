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
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { cleanName, DICTIONARY_COLUMNS, DICTIONARY_KINDS, DictionaryKind, matchKey } from '../dictionaries/dictionary-names';
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
  create(args: { data: { name_ru: string; name_uz?: string | null } }): Promise<DictionaryRow>;
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
  const row = await dictionaryTable(db, kind).create({ data: { name_ru: cleanName(name) } });
  await audit.log({ staffId, action: 'dictionary.created', entityType: kind, entityId: row.id, after: row }, db);
  return { row, created: true };
}

const clean = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanName(value) : value);
const cleanOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanName(value) || null : value);

/** name_ru is «the name» of every dictionary (suppliers and Ozon accounts store it as `name`). */
export class DictionaryInput {
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

export class DictionaryPatch {
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
}

/** One shape for the admin screen: `products` = how many products (or purchases) use the value. */
const toView = (kind: AnyDictionaryKind, r: AnyRow) => ({
  id: r.id,
  name_ru: nameOf(r),
  name_uz: isPurchaseKind(kind) ? null : (r.name_uz ?? null),
  status: r.status,
  products: r._count?.products ?? r._count?.purchases ?? 0,
  ...(kind === 'suppliers' && { note: r.note ?? null }),
});

/** Stage 1.1 + 2A.1: brands / manufacturers / countries / forms / suppliers / Ozon accounts. Never deleted, only archived. */
@Injectable()
export class AdminDictionariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(kind: AnyDictionaryKind, includeArchived = false) {
    const rows = await anyTable(this.prisma, kind).findMany({
      where: includeArchived ? {} : { status: 'active' },
      orderBy: [{ status: 'asc' }, { [isPurchaseKind(kind) ? 'name' : 'name_ru']: 'asc' }],
      include: { _count: { select: { [isPurchaseKind(kind) ? 'purchases' : 'products']: true } } },
    });
    return rows.map((r) => toView(kind, r));
  }

  async create(staffId: string, kind: AnyDictionaryKind, dto: DictionaryInput) {
    return this.write(kind, async (tx) => {
      const same = await findSame(tx, kind, dto.name_ru);
      if (same) throw duplicate(kind, same);
      const data = isPurchaseKind(kind)
        ? { name: dto.name_ru, ...(kind === 'suppliers' && { note: dto.note ?? null }) }
        : { name_ru: dto.name_ru, name_uz: dto.name_uz ?? null };
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
      if (dto.status !== undefined && dto.status !== before.status) data.status = dto.status;
      if (!Object.keys(data).length) return toView(kind, before);

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
  list(@CurrentStaff() me: StaffContext, @Param('kind') raw: string, @Query() q: DictionaryQuery) {
    const kind = kindOf(raw);
    const role = me.staff.role;
    if (isPurchaseKind(kind) && !can(role, 'purchases.view') && !can(role, 'settings.dictionaries')) {
      throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: `Role ${role} cannot see ${kind}` });
    }
    return this.dictionaries.list(kind, q.include_archived);
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

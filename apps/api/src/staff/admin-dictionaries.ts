import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
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
import { cleanName, DICTIONARY_COLUMNS, DictionaryKind, isDictionaryKind, matchKey } from '../dictionaries/dictionary-names';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

type Db = Prisma.TransactionClient | PrismaService;

export interface DictionaryRow {
  id: string;
  name_ru: string;
  name_uz: string | null;
  status: EntityStatus;
  created_at: Date;
  updated_at: Date;
}

/** The four dictionary tables have the same columns; this is the part of their Prisma delegates used here. */
interface DictionaryTable {
  findMany(args?: object): Promise<(DictionaryRow & { _count?: { products: number } })[]>;
  findUnique(args: { where: { id: string } }): Promise<DictionaryRow | null>;
  create(args: { data: { name_ru: string; name_uz?: string | null } }): Promise<DictionaryRow>;
  update(args: { where: { id: string }; data: Partial<Pick<DictionaryRow, 'name_ru' | 'name_uz' | 'status'>> }): Promise<DictionaryRow>;
}

export const dictionaryTable = (db: Db, kind: DictionaryKind) => db[kind] as unknown as DictionaryTable;

/** Same value already there (case, spaces, ё/е ignored)? Archived values count too: they are restored, not duplicated. */
async function findSame(db: Db, kind: DictionaryKind, name: string, exceptId?: string) {
  const key = matchKey(name);
  return (await dictionaryTable(db, kind).findMany()).find((r) => r.id !== exceptId && matchKey(r.name_ru) === key) ?? null;
}

function duplicate(kind: DictionaryKind, row: DictionaryRow) {
  return new ConflictException({
    code: 'DICTIONARY_DUPLICATE',
    message: `«${row.name_ru}» уже есть (${DICTIONARY_COLUMNS[kind].label}${row.status === 'archived' ? ', в архиве' : ''})`,
    existing: { id: row.id, name_ru: row.name_ru, status: row.status },
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
  const same = await findSame(db, kind, name);
  if (same) return { row: same, created: false };
  const row = await dictionaryTable(db, kind).create({ data: { name_ru: cleanName(name) } });
  await audit.log({ staffId, action: 'dictionary.created', entityType: kind, entityId: row.id, after: row }, db);
  return { row, created: true };
}

export class DictionaryInput {
  @ApiProperty({ example: 'Эвалар' }) @Transform(({ value }) => (typeof value === 'string' ? cleanName(value) : value)) @IsString() @IsNotEmpty() @MaxLength(200) name_ru!: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanName(value) || null : value))
  @IsString()
  @MaxLength(200)
  name_uz?: string | null;
}

export class DictionaryPatch {
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? cleanName(value) : value)) @IsString() @IsNotEmpty() @MaxLength(200) name_ru?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanName(value) || null : value))
  @IsString()
  @MaxLength(200)
  name_uz?: string | null;
  @ApiPropertyOptional({ enum: EntityStatus }) @IsOptional() @IsEnum(EntityStatus) status?: EntityStatus;
}

export class DictionaryQuery {
  @ApiPropertyOptional({ description: 'true — вместе с архивными' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  include_archived?: boolean;
}

const toView = (r: DictionaryRow & { _count?: { products: number } }) => ({
  id: r.id,
  name_ru: r.name_ru,
  name_uz: r.name_uz,
  status: r.status,
  products: r._count?.products ?? 0,
});

/** Stage 1.1: brands / manufacturers / countries / forms. Values are never deleted, only archived. */
@Injectable()
export class AdminDictionariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(kind: DictionaryKind, includeArchived = false) {
    const rows = await dictionaryTable(this.prisma, kind).findMany({
      where: includeArchived ? {} : { status: 'active' },
      orderBy: [{ status: 'asc' }, { name_ru: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    return rows.map(toView);
  }

  async create(staffId: string, kind: DictionaryKind, dto: DictionaryInput) {
    return this.write(kind, async (tx) => {
      const same = await findSame(tx, kind, dto.name_ru);
      if (same) throw duplicate(kind, same);
      const row = await dictionaryTable(tx, kind).create({ data: { name_ru: dto.name_ru, name_uz: dto.name_uz ?? null } });
      await this.audit.log({ staffId, action: 'dictionary.created', entityType: kind, entityId: row.id, after: row }, tx);
      return toView(row);
    });
  }

  /**
   * Rename and/or archive. A new name is copied into the text column of every product linked to this value
   * (the Mini App reads that column), in the same transaction, with one audit entry.
   */
  async update(staffId: string, kind: DictionaryKind, id: string, dto: DictionaryPatch) {
    return this.write(kind, async (tx) => {
      const before = await dictionaryTable(tx, kind).findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Dictionary value not found');
      if (dto.name_ru !== undefined && dto.name_ru !== before.name_ru) {
        const same = await findSame(tx, kind, dto.name_ru, id);
        if (same) throw duplicate(kind, same);
      }
      const data: Partial<Pick<DictionaryRow, 'name_ru' | 'name_uz' | 'status'>> = {};
      if (dto.name_ru !== undefined && dto.name_ru !== before.name_ru) data.name_ru = dto.name_ru;
      if (dto.name_uz !== undefined && dto.name_uz !== before.name_uz) data.name_uz = dto.name_uz;
      if (dto.status !== undefined && dto.status !== before.status) data.status = dto.status;
      if (!Object.keys(data).length) return toView(before);

      const after = await dictionaryTable(tx, kind).update({ where: { id }, data });
      let productsUpdated = 0;
      if (data.name_ru) {
        const cols = DICTIONARY_COLUMNS[kind];
        productsUpdated = (await tx.products.updateMany({ where: { [cols.id]: id }, data: { [cols.text]: data.name_ru } })).count;
      }
      const action = data.name_ru ? 'dictionary.renamed' : data.status === 'archived' ? 'dictionary.archived' : data.status === 'active' ? 'dictionary.restored' : 'dictionary.updated';
      await this.audit.log({ staffId, action, entityType: kind, entityId: id, before, after: { ...after, products_updated: productsUpdated } }, tx);
      return { ...toView(after), products_updated: productsUpdated };
    });
  }

  private async write<T>(kind: DictionaryKind, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (e) {
      // Two admins adding the same name at once: the unique index answers, not a 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'DICTIONARY_DUPLICATE', message: `Такое значение уже есть (${DICTIONARY_COLUMNS[kind].label})` });
      }
      throw e;
    }
  }
}

function kindOf(raw: string): DictionaryKind {
  if (!isDictionaryKind(raw)) throw new BadRequestException({ code: 'UNKNOWN_DICTIONARY', message: 'brands, manufacturers, countries or forms' });
  return raw;
}

@ApiTags('staff: dictionaries')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/dictionaries')
export class AdminDictionariesController {
  constructor(private readonly dictionaries: AdminDictionariesService) {}

  /** The product card shows these choices to everyone who may open it. */
  @Get(':kind')
  @RequirePermission('products.view', 'settings.dictionaries')
  list(@Param('kind') kind: string, @Query() q: DictionaryQuery) {
    return this.dictionaries.list(kindOf(kind), q.include_archived);
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

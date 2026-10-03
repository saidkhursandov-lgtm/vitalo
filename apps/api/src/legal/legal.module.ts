import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';

/** Documents a customer must accept (first screen of the Mini App). */
export const LEGAL_CODES = ['offer', 'privacy'] as const;
export type LegalCode = (typeof LEGAL_CODES)[number];

type Db = Prisma.TransactionClient | PrismaService;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Fields left for the owner to fill, like "[полное наименование, ИНН, адрес]" or an empty "[ ]" (Markdown-escaped or not). */
export function findPlaceholders(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = text.match(/\\?\[[^\]\n]{0,120}?\\?\]/g) ?? [];
  // A Markdown link "[text](url)" is not a placeholder.
  return [...new Set(found.filter((m) => !text.includes(`${m}(`)).map((m) => m.replace(/\\/g, '')))];
}

export class AcceptLegalDto {
  @ApiPropertyOptional({ description: '«Получать акции и новости» (по умолчанию выключено)' }) @IsOptional() @IsBoolean() marketing_opt_in?: boolean;
}

export class LegalDraftDto {
  @ApiProperty({ enum: LEGAL_CODES }) @IsIn(LEGAL_CODES) code!: LegalCode;
  @ApiProperty({ example: '1.0' }) @Transform(trim) @Matches(/^[0-9A-Za-z.\-_]{1,20}$/, { message: 'version: 1-20 chars, letters, digits, . - _' }) version!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100_000) text_ru!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100_000) text_uz!: string;
}

export class LegalDraftPatch {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @Matches(/^[0-9A-Za-z.\-_]{1,20}$/) version?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100_000) text_ru?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100_000) text_uz?: string;
}

@Injectable()
export class LegalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  activeDocuments(db: Db = this.prisma) {
    return db.legal_documents.findMany({ where: { status: 'active', code: { in: [...LEGAL_CODES] } }, orderBy: { code: 'asc' } });
  }

  async documents() {
    return (await this.activeDocuments()).map((d) => ({ code: d.code, version: d.version, text_ru: d.text_ru, text_uz: d.text_uz ?? d.text_ru, published_at: d.published_at }));
  }

  /** accepted = the user has accepted every currently active document (no active documents -> nothing to accept). */
  async status(userId: string, db: Db = this.prisma) {
    const docs = await this.activeDocuments(db);
    const accepted = docs.length
      ? await db.legal_acceptances.findMany({ where: { user_id: userId, legal_document_id: { in: docs.map((d) => d.id) } }, select: { legal_document_id: true } })
      : [];
    const done = new Set(accepted.map((a) => a.legal_document_id));
    return {
      accepted: docs.every((d) => done.has(d.id)),
      documents: docs.map((d) => ({ code: d.code, version: d.version, accepted: done.has(d.id) })),
    };
  }

  /** Records acceptance of every active document (once per version) and the optional marketing consent. */
  async accept(userId: string, dto: AcceptLegalDto) {
    await this.prisma.$transaction(async (tx) => {
      const docs = await this.activeDocuments(tx);
      const existing = await tx.legal_acceptances.findMany({ where: { user_id: userId, legal_document_id: { in: docs.map((d) => d.id) } } });
      const missing = docs.filter((d) => !existing.some((e) => e.legal_document_id === d.id));
      if (missing.length) await tx.legal_acceptances.createMany({ data: missing.map((d) => ({ user_id: userId, legal_document_id: d.id, source: 'mini_app' })) });
      await tx.users.update({ where: { id: userId }, data: { marketing_opt_in: dto.marketing_opt_in ?? false } });
    });
    return this.status(userId);
  }

  /** Orders need the current offer accepted (the Mini App shows the consent screen first). */
  async assertAccepted(userId: string, db: Db = this.prisma) {
    if (!(await this.status(userId, db)).accepted) {
      throw new ForbiddenException({ code: 'LEGAL_NOT_ACCEPTED', message: 'Please accept the public offer and the privacy policy first' });
    }
  }

  // ---------------- admin ----------------

  async adminList() {
    const rows = await this.prisma.legal_documents.findMany({
      orderBy: [{ code: 'asc' }, { published_at: { sort: 'desc', nulls: 'first' } }],
      include: { _count: { select: { acceptances: true } } },
    });
    return rows.map((d) => ({
      id: d.id,
      code: d.code,
      version: d.version,
      status: d.status,
      published_at: d.published_at,
      text_ru: d.text_ru,
      text_uz: d.text_uz ?? '',
      acceptances: d._count.acceptances,
      placeholders: findPlaceholders(`${d.text_ru}\n${d.text_uz ?? ''}`),
    }));
  }

  async createDraft(staffId: string, dto: LegalDraftDto) {
    try {
      const d = await this.prisma.legal_documents.create({ data: { ...dto, status: 'draft' } });
      await this.audit.log({ staffId, action: 'legal.draft_created', entityType: 'legal_document', entityId: d.id, after: { code: d.code, version: d.version } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'LEGAL_VERSION_EXISTS', message: 'This version already exists' });
      }
      throw e;
    }
    return this.adminList();
  }

  /** Only drafts are editable: a published text is what customers accepted and must stay as it was. */
  async updateDraft(staffId: string, id: string, dto: LegalDraftPatch) {
    const d = await this.prisma.legal_documents.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Document not found');
    if (d.status !== 'draft') throw new ConflictException({ code: 'LEGAL_NOT_DRAFT', message: 'Published versions cannot be edited; create a new version' });
    try {
      await this.prisma.legal_documents.update({ where: { id }, data: dto });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'LEGAL_VERSION_EXISTS', message: 'This version already exists' });
      }
      throw e;
    }
    await this.audit.log({ staffId, action: 'legal.draft_updated', entityType: 'legal_document', entityId: id, after: { version: dto.version ?? d.version } });
    return this.adminList();
  }

  /** The draft becomes the active version; the previous one is archived. Customers see the consent screen again. */
  async publish(staffId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.legal_documents.findUnique({ where: { id } });
      if (!d) throw new NotFoundException('Document not found');
      if (d.status !== 'draft') throw new ConflictException({ code: 'LEGAL_NOT_DRAFT', message: 'Only a draft can be published' });
      if (!d.text_uz?.trim()) throw new ConflictException({ code: 'LEGAL_UZ_MISSING', message: 'The Uzbek text is empty' });
      await tx.legal_documents.updateMany({ where: { code: d.code, status: 'active' }, data: { status: 'archived' } });
      await tx.legal_documents.update({ where: { id }, data: { status: 'active', published_at: new Date() } });
      await this.audit.log({ staffId, action: 'legal.published', entityType: 'legal_document', entityId: id, after: { code: d.code, version: d.version } }, tx);
    });
    return this.adminList();
  }
}

@ApiTags('legal')
@Controller('legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  @Get('documents')
  documents() {
    return this.legal.documents();
  }

  @Get('status')
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  status(@CurrentAuth() auth: AuthContext) {
    return this.legal.status(auth.user.id);
  }

  @Post('accept')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  accept(@CurrentAuth() auth: AuthContext, @Body() dto: AcceptLegalDto) {
    return this.legal.accept(auth.user.id, dto);
  }
}

@ApiTags('staff: legal')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('settings.manage')
@Controller('staff/legal')
export class AdminLegalController {
  constructor(private readonly legal: LegalService) {}

  @Get()
  list() {
    return this.legal.adminList();
  }

  @Post()
  create(@CurrentStaff() me: StaffContext, @Body() dto: LegalDraftDto) {
    return this.legal.createDraft(me.staff.id, dto);
  }

  @Patch(':id')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: LegalDraftPatch) {
    return this.legal.updateDraft(me.staff.id, id, dto);
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.legal.publish(me.staff.id, id);
  }
}

/** AdminLegalController is registered in StaffModule (it needs the staff guard). */
@Module({ imports: [AuthModule], controllers: [LegalController], providers: [LegalService, AuditService], exports: [LegalService] })
export class LegalModule {}

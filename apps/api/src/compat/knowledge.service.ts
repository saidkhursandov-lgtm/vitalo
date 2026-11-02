import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { staff_users } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { can } from '../staff/permissions';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { RULE_KINDS, RULE_STATUSES, SUBSTANCE_KINDS, WHEN, normalizeText, withParents, type RuleKind, type RuleStatus, type SubstanceKind, type When } from './knowledge';

const TEXT_MAX = 600;

/** Synonyms as stored: lower case, trimmed, no empty ones and no repeats. */
function cleanSynonyms(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((s) => normalizeText(s)).filter((s) => s.length >= 2))];
}

/**
 * 3.8: «Совместимость → Вещества / Правила / Товары» (D-45). Admins and specialists edit the dictionary, the rules and
 * the substances of products; **only an admin approves a rule** — VITALO AI sees approved rules only. A manager looks.
 * Nothing is deleted: a substance is switched off, a rule is set to «выключено».
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------- substances ----------------

  async substances() {
    const rows = await this.prisma.substances.findMany({
      orderBy: [{ sort_order: 'asc' }, { name_ru: 'asc' }],
      include: { parent: { select: { id: true, name_ru: true } }, _count: { select: { products: true, rules_a: true, rules_b: true } } },
    });
    return rows.map((s) => ({
      id: s.id,
      code: s.code,
      kind: s.kind as SubstanceKind,
      name_ru: s.name_ru,
      name_uz: s.name_uz,
      synonyms: s.synonyms,
      parent: s.parent,
      enabled: s.enabled,
      products: s._count.products,
      rules: s._count.rules_a + s._count.rules_b,
    }));
  }

  private async checkParent(id: string | null | undefined, self?: string) {
    if (!id) return;
    if (id === self) throw new BadRequestException({ code: 'BAD_PARENT', message: 'A substance cannot be a form of itself' });
    const all = await this.prisma.substances.findMany({ select: { id: true, parent_id: true } });
    const parentOf = new Map(all.map((s) => [s.id, s.parent_id]));
    if (!parentOf.has(id)) throw new BadRequestException({ code: 'BAD_PARENT', message: 'Unknown parent substance' });
    if (self && withParents([id], parentOf).has(self)) throw new BadRequestException({ code: 'BAD_PARENT', message: 'A loop of forms' });
  }

  async createSubstance(me: staff_users, dto: SubstanceDto) {
    const code = dto.code?.trim() || normalizeText(dto.name_ru).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `s_${Date.now()}`;
    if (await this.prisma.substances.findUnique({ where: { code } })) throw new ConflictException({ code: 'CODE_TAKEN', message: `Code ${code} is taken` });
    await this.checkParent(dto.parent_id);
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.substances.create({
        data: { code, kind: dto.kind ?? 'substance', name_ru: dto.name_ru.trim(), name_uz: dto.name_uz.trim(), synonyms: cleanSynonyms(dto.synonyms), parent_id: dto.parent_id ?? null, sort_order: 500 },
      });
      await this.audit.log({ staffId: me.id, action: 'compat.substance_created', entityType: 'substance', entityId: s.id, after: s }, tx);
    });
    return this.substances();
  }

  async updateSubstance(me: staff_users, id: string, dto: Partial<SubstanceDto> & { enabled?: boolean }) {
    const before = await this.prisma.substances.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Substance not found');
    if (dto.parent_id !== undefined) await this.checkParent(dto.parent_id, id);
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.substances.update({
        where: { id },
        data: {
          ...(dto.name_ru?.trim() && { name_ru: dto.name_ru.trim() }),
          ...(dto.name_uz?.trim() && { name_uz: dto.name_uz.trim() }),
          ...(dto.synonyms && { synonyms: cleanSynonyms(dto.synonyms) }),
          ...(dto.kind && { kind: dto.kind }),
          ...(dto.parent_id !== undefined && { parent_id: dto.parent_id }),
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        },
      });
      await this.audit.log({ staffId: me.id, action: 'compat.substance_updated', entityType: 'substance', entityId: id, before, after }, tx);
    });
    return this.substances();
  }

  // ---------------- rules ----------------

  async rules(status?: RuleStatus) {
    const rows = await this.prisma.compat_rules.findMany({
      where: status ? { status } : {},
      orderBy: [{ created_at: 'asc' }],
      include: { substance_a: { select: { id: true, name_ru: true, kind: true } }, substance_b: { select: { id: true, name_ru: true, kind: true } }, approver: { select: { name: true } } },
    });
    const order: Record<string, number> = { draft: 0, approved: 1, off: 2 };
    return rows
      .map((r) => ({
        id: r.id,
        a: r.substance_a,
        b: r.substance_b,
        kind: r.kind as RuleKind,
        interval_hours: r.interval_hours,
        when_a: r.when_a as When | null,
        when_b: r.when_b as When | null,
        text_ru: r.text_ru,
        text_uz: r.text_uz,
        source: r.source,
        origin: r.origin,
        status: r.status as RuleStatus,
        approved_by: r.approver?.name ?? null,
        approved_at: r.approved_at,
        updated_at: r.updated_at,
      }))
      .sort((x, y) => order[x.status] - order[y.status]);
  }

  private async checkPair(a: string, b: string, except?: string) {
    if (a === b) throw new BadRequestException({ code: 'SAME_SUBSTANCE', message: 'A and B must be different substances' });
    const n = await this.prisma.substances.count({ where: { id: { in: [a, b] } } });
    if (n !== 2) throw new BadRequestException({ code: 'BAD_SUBSTANCE', message: 'Unknown substance' });
    const clash = await this.prisma.compat_rules.findFirst({ where: { id: except ? { not: except } : undefined, OR: [{ substance_a_id: a, substance_b_id: b }, { substance_a_id: b, substance_b_id: a }] } });
    if (clash) throw new ConflictException({ code: 'RULE_EXISTS', message: 'A rule for this pair already exists' });
  }

  async createRule(me: staff_users, dto: RuleDto) {
    await this.checkPair(dto.substance_a_id, dto.substance_b_id);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.compat_rules.create({
        data: {
          substance_a_id: dto.substance_a_id,
          substance_b_id: dto.substance_b_id,
          kind: dto.kind,
          interval_hours: dto.interval_hours ?? null,
          when_a: dto.when_a ?? null,
          when_b: dto.when_b ?? null,
          text_ru: dto.text_ru.trim(),
          text_uz: dto.text_uz.trim(),
          source: dto.source?.trim() || null,
          origin: 'admin',
          status: 'draft',
        },
      });
      await this.audit.log({ staffId: me.id, action: 'compat.rule_created', entityType: 'compat_rule', entityId: r.id, after: r }, tx);
    });
    return this.rules();
  }

  /**
   * Any change of an approved rule by a specialist sends it back to «черновик» (an admin approves again); an admin's
   * own edit keeps it approved.
   */
  async updateRule(me: staff_users, id: string, dto: Partial<RuleDto>) {
    const before = await this.prisma.compat_rules.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Rule not found');
    const a = dto.substance_a_id ?? before.substance_a_id;
    const b = dto.substance_b_id ?? before.substance_b_id;
    if (a !== before.substance_a_id || b !== before.substance_b_id) await this.checkPair(a, b, id);
    const backToDraft = before.status === 'approved' && !can(me.role, 'compat.rules.approve');
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.compat_rules.update({
        where: { id },
        data: {
          substance_a_id: a,
          substance_b_id: b,
          ...(dto.kind && { kind: dto.kind }),
          ...(dto.interval_hours !== undefined && { interval_hours: dto.interval_hours }),
          ...(dto.when_a !== undefined && { when_a: dto.when_a }),
          ...(dto.when_b !== undefined && { when_b: dto.when_b }),
          ...(dto.text_ru?.trim() && { text_ru: dto.text_ru.trim() }),
          ...(dto.text_uz?.trim() && { text_uz: dto.text_uz.trim() }),
          ...(dto.source !== undefined && { source: dto.source?.trim() || null }),
          ...(backToDraft && { status: 'draft', approved_by: null, approved_at: null }),
        },
      });
      await this.audit.log({ staffId: me.id, action: 'compat.rule_updated', entityType: 'compat_rule', entityId: id, before, after }, tx);
    });
    return this.rules();
  }

  /** «Одобрить» (admin only), «Выключить», «Вернуть в черновик». */
  async setRuleStatus(me: staff_users, ids: string[], status: RuleStatus, now = new Date()) {
    if (status === 'approved' && !can(me.role, 'compat.rules.approve')) {
      throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: 'Only an admin approves rules' });
    }
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.compat_rules.findMany({ where: { id: { in: ids } } });
      if (rows.length !== ids.length) throw new NotFoundException('Rule not found');
      for (const r of rows) {
        if (r.status === status) continue;
        await tx.compat_rules.update({
          where: { id: r.id },
          data: status === 'approved' ? { status, approved_by: me.id, approved_at: now } : { status, approved_by: null, approved_at: null },
        });
        await this.audit.log({ staffId: me.id, action: `compat.rule_${status}`, entityType: 'compat_rule', entityId: r.id, before: { status: r.status }, after: { status } }, tx);
      }
    });
    return this.rules();
  }

  // ---------------- products ----------------

  async products() {
    const rows = await this.prisma.products.findMany({
      where: { status: { not: 'archived' } },
      orderBy: { sku: 'asc' },
      select: { id: true, sku: true, status: true, name_ru: true, short_name_ru: true, label_composition_ru: true, substances: { select: { substance: { select: { id: true, name_ru: true } } } } },
    });
    return rows.map((p) => ({
      id: p.id,
      sku: p.sku,
      status: p.status,
      name: p.short_name_ru || p.name_ru,
      composition: p.label_composition_ru,
      substances: p.substances.map((s) => s.substance).sort((x, y) => x.name_ru.localeCompare(y.name_ru)),
    }));
  }

  async setProductSubstances(me: staff_users, productId: string, ids: string[]) {
    const product = await this.prisma.products.findUnique({ where: { id: productId }, select: { id: true, substances: { select: { substance_id: true } } } });
    if (!product) throw new NotFoundException('Product not found');
    const unique = [...new Set(ids)];
    if ((await this.prisma.substances.count({ where: { id: { in: unique } } })) !== unique.length) throw new BadRequestException({ code: 'BAD_SUBSTANCE', message: 'Unknown substance' });
    await this.prisma.$transaction(async (tx) => {
      await tx.product_substances.deleteMany({ where: { product_id: productId, substance_id: { notIn: unique } } });
      await tx.product_substances.createMany({ data: unique.map((substance_id) => ({ product_id: productId, substance_id })), skipDuplicates: true });
      await this.audit.log({ staffId: me.id, action: 'compat.product_substances', entityType: 'product', entityId: productId, before: { substances: product.substances.map((s) => s.substance_id) }, after: { substances: unique } }, tx);
    });
    return this.products();
  }
}

// ---------------- DTOs ----------------

export class SubstanceDto {
  @ApiPropertyOptional({ description: 'латиница, цифры и _; пусто — из названия' }) @IsOptional() @IsString() @Matches(/^[a-z0-9_]{2,40}$/) code?: string;
  @ApiPropertyOptional({ enum: SUBSTANCE_KINDS }) @IsOptional() @IsIn(SUBSTANCE_KINDS) kind?: SubstanceKind;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name_ru!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name_uz!: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(80, { each: true }) synonyms?: string[];
  @ApiPropertyOptional({ description: 'форма какого вещества (P-5-P → B6)' }) @IsOptional() @IsUUID() parent_id?: string | null;
}

class SubstancePatch extends SubstanceDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) declare name_ru: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) declare name_uz: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
}

export class RuleDto {
  @ApiProperty() @IsUUID() substance_a_id!: string;
  @ApiProperty() @IsUUID() substance_b_id!: string;
  @ApiProperty({ enum: RULE_KINDS }) @IsIn(RULE_KINDS) kind!: RuleKind;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(24) interval_hours?: number | null;
  @ApiPropertyOptional({ enum: WHEN }) @IsOptional() @IsIn(WHEN) when_a?: When | null;
  @ApiPropertyOptional({ enum: WHEN }) @IsOptional() @IsIn(WHEN) when_b?: When | null;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(TEXT_MAX) text_ru!: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(TEXT_MAX) text_uz!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) source?: string | null;
}

class RulePatch {
  @ApiPropertyOptional() @IsOptional() @IsUUID() substance_a_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() substance_b_id?: string;
  @ApiPropertyOptional({ enum: RULE_KINDS }) @IsOptional() @IsIn(RULE_KINDS) kind?: RuleKind;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(24) interval_hours?: number | null;
  @ApiPropertyOptional({ enum: WHEN }) @IsOptional() @IsIn(WHEN) when_a?: When | null;
  @ApiPropertyOptional({ enum: WHEN }) @IsOptional() @IsIn(WHEN) when_b?: When | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(5) @MaxLength(TEXT_MAX) text_ru?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(5) @MaxLength(TEXT_MAX) text_uz?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) source?: string | null;
}

class RuleStatusDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids!: string[];
  @ApiProperty({ enum: RULE_STATUSES }) @IsIn(RULE_STATUSES) status!: RuleStatus;
}

class RuleListQuery {
  @ApiPropertyOptional({ enum: RULE_STATUSES }) @IsOptional() @IsIn(RULE_STATUSES) status?: RuleStatus;
}

class ProductSubstancesDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(30) @IsUUID('all', { each: true }) substance_ids!: string[];
}

// ---------------- controller ----------------

@ApiTags('staff: compat')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/compat')
export class AdminKnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('substances')
  @RequirePermission('compat.view')
  substances() {
    return this.knowledge.substances();
  }

  @Post('substances')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  createSubstance(@CurrentStaff() me: StaffContext, @Body() dto: SubstanceDto) {
    return this.knowledge.createSubstance(me.staff, dto);
  }

  @Patch('substances/:id')
  @RequirePermission('compat.answer')
  updateSubstance(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SubstancePatch) {
    return this.knowledge.updateSubstance(me.staff, id, dto);
  }

  @Get('rules')
  @RequirePermission('compat.view')
  rules(@Query() q: RuleListQuery) {
    return this.knowledge.rules(q.status);
  }

  @Post('rules')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  createRule(@CurrentStaff() me: StaffContext, @Body() dto: RuleDto) {
    return this.knowledge.createRule(me.staff, dto);
  }

  @Patch('rules/:id')
  @RequirePermission('compat.answer')
  updateRule(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RulePatch) {
    return this.knowledge.updateRule(me.staff, id, dto);
  }

  /** «Одобрить» needs compat.rules.approve (admin only); «Выключить» / «В черновик» — compat.answer. */
  @Post('rules/status')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  setStatus(@CurrentStaff() me: StaffContext, @Body() dto: RuleStatusDto) {
    return this.knowledge.setRuleStatus(me.staff, dto.ids, dto.status);
  }

  @Get('products')
  @RequirePermission('compat.view')
  products() {
    return this.knowledge.products();
  }

  @Put('products/:id/substances')
  @RequirePermission('compat.answer')
  setProductSubstances(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ProductSubstancesDto) {
    return this.knowledge.setProductSubstances(me.staff, id, dto.substance_ids);
  }
}

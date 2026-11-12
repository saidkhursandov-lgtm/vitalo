import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, type staff_users } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AnalyticsService } from '../analytics/analytics.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { can } from '../staff/permissions';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { productTitle } from '../waitlist/waitlist';
import { SYSTEM_COMMON, costUsd, tashkentMonthStart } from './ai';
import { AI_MODEL, AiCallError, type AiModel } from './ai-client';
import {
  DOCTOR_LINE,
  DURATIONS,
  GOALS,
  GOAL_SCHEMA,
  KINDS,
  LEVELS,
  LEVEL_LABELS,
  SYSTEM_GOAL,
  bestLevel,
  checkGoalAnswer,
  goalDataBlock,
  isDuration,
  isGoal,
  isKind,
  type Duration,
  type Fit,
  type Goal,
  type GoalData,
  type GoalEvidenceLine,
  type Level,
} from './ai-goal';
import { AiService } from './ai.service';
import { tashkentDayStart, type Lang } from './compat';
import { CompatService, langOf, type Item } from './compat.service';
import { withParents } from './knowledge';

const MAX_TOKENS = 2000;

/** What the cart shows: a line per product with the level in words, the general steps and the doctor line. */
export interface GoalView {
  goal: Goal;
  duration: Duration;
  kind: string;
  summary: string;
  products: { product_id: string; name: string; fit: Fit; level: Level | null; level_text: string | null; text: string }[];
  steps: string[];
  doctor: string;
  left_today: number;
}

/**
 * Шаг 0б (D-68, D-69): «Задать вопрос VITALO AI по корзине». The customer chooses chips only; the model gets the chips,
 * the products of the cart and the approved «вещество → цель» rows (never the customer's data, D-45). The answer is
 * checked before it is shown; the level of evidence is taken from our base, not from the model. No cache: every set of
 * chips is a new request, counted in the daily limit of the chat (`chat_daily_limit`) and in the monthly budget.
 */
@Injectable()
export class AiGoalService {
  private readonly logger = new Logger(AiGoalService.name);
  private readonly busy = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly compat: CompatService,
    private readonly ai: AiService,
    private readonly analytics: AnalyticsService,
    @Inject(AI_MODEL) private readonly model: AiModel,
  ) {}

  private doneToday(userId: string, now: Date) {
    return this.prisma.ai_requests.count({ where: { user_id: userId, scenario: 'cart_goal', status: 'ok', created_at: { gte: tashkentDayStart(now) } } });
  }

  /**
   * POST /compat/ai/goal. 403 CONSENT_REQUIRED, 400 NOT_ENOUGH_ITEMS / BAD_CHOICE, 409 BUSY, 429 AI_DAILY_LIMIT,
   * 503 AI_UNAVAILABLE (switched off, no key, the budget is spent, the model failed or its answer did not pass the checks).
   */
  async ask(userId: string, choice: { goal: string; duration: string; kind: string }, now = new Date()): Promise<GoalView> {
    if (this.busy.has(userId)) throw new HttpException({ code: 'BUSY', message: 'The question is already being answered' }, HttpStatus.CONFLICT);
    this.busy.add(userId);
    try {
      return await this.run(userId, choice, now);
    } finally {
      this.busy.delete(userId);
    }
  }

  private async run(userId: string, choice: { goal: string; duration: string; kind: string }, now: Date): Promise<GoalView> {
    const { goal, duration, kind } = choice;
    if (!isGoal(goal) || !isDuration(duration) || !isKind(goal, kind)) throw new BadRequestException({ code: 'BAD_CHOICE', message: 'Unknown goal, duration or kind' });
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { ai_consent_at: true, language: true } });
    if (!user.ai_consent_at) throw new ForbiddenException({ code: 'CONSENT_REQUIRED', message: 'The customer has not agreed to VITALO AI yet' });
    const lang = langOf(user.language);
    const items = await this.compat.cartItems(userId);
    if (!items.length) throw new BadRequestException({ code: 'NOT_ENOUGH_ITEMS', message: 'The cart is empty' });
    const s = await this.ai.settings();
    const unavailable = (reason: string) => new HttpException({ code: 'AI_UNAVAILABLE', message: `VITALO AI cannot answer now: ${reason}` }, HttpStatus.SERVICE_UNAVAILABLE);
    if (!s.enabled || !this.model.ready()) throw unavailable('off');
    const done = await this.doneToday(userId, now);
    if (done >= s.chat_daily_limit) {
      await this.analytics.track(userId, 'compat_ai_limit', { scenario: 'cart_goal', limit: s.chat_daily_limit });
      throw new HttpException({ code: 'AI_DAILY_LIMIT', message: `No more than ${s.chat_daily_limit} questions a day` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const spent = await this.prisma.ai_requests.aggregate({ _sum: { cost_usd: true }, where: { created_at: { gte: tashkentMonthStart(now) } } });
    if (Number(spent._sum.cost_usd ?? 0) >= s.monthly_budget_usd) throw unavailable('budget');

    const { data, refs } = await this.goalData(items, lang, goal, duration, kind);
    const log = { scenario: 'cart_goal', user_id: userId, set_key: [...refs.values()].sort().join(','), lang, model: s.goal_model };
    const started = Date.now();
    let completion;
    try {
      completion = await this.model.complete({ model: s.goal_model, system: `${SYSTEM_COMMON}\n\n${SYSTEM_GOAL}`, data: goalDataBlock(data), schema: GOAL_SCHEMA, maxTokens: MAX_TOKENS });
    } catch (e) {
      const code = e instanceof AiCallError ? e.code : 'error';
      this.logger.warn(`VITALO AI goal question failed: ${code}`);
      await this.prisma.ai_requests.create({ data: { ...log, status: code === 'timeout' ? 'timeout' : 'error', latency_ms: Date.now() - started, error: code } });
      throw unavailable(code);
    }
    const checked = completion.outcome === 'ok' ? checkGoalAnswer(completion.json, data) : ({ ok: false, error: completion.outcome } as const);
    await this.prisma.ai_requests.create({
      data: {
        ...log,
        status: checked.ok ? 'ok' : 'invalid',
        input_tokens: completion.inputTokens,
        output_tokens: completion.outputTokens,
        cost_usd: new Prisma.Decimal(costUsd(s.goal_model, completion.inputTokens, completion.outputTokens).toFixed(6)),
        latency_ms: Date.now() - started,
        error: checked.ok ? null : checked.error,
      },
    });
    if (!checked.ok) throw unavailable('invalid');

    const a = checked.answer;
    // архитектура 3.4: the share of answers «можно не брать» is watched in the analytics
    await this.analytics.track(userId, 'compat_ai_goal', {
      goal,
      duration,
      kind,
      lang,
      products: items.length,
      unlikely: a.products.filter((p) => p.fit === 'unlikely').length,
      no_data: a.products.filter((p) => p.fit === 'no_data').length,
      model: s.goal_model,
    });
    const byRef = new Map(data.cart.map((p) => [p.ref, p]));
    return {
      goal,
      duration,
      kind,
      summary: a.summary,
      products: a.products.map((p) => {
        const level = bestLevel(byRef.get(p.ref)!.evidence);
        return { product_id: refs.get(p.ref)!, name: byRef.get(p.ref)!.name, fit: p.fit, level, level_text: level ? LEVEL_LABELS[level][lang] : null, text: p.text };
      }),
      steps: a.steps,
      doctor: DOCTOR_LINE[lang],
      left_today: Math.max(0, s.chat_daily_limit - done - 1),
    };
  }

  /**
   * The data block: products of the cart with their substances (a form counts for its substance too: P-5-P → B6) and
   * the approved rows of «вещество → цель» for the goal. refs: SKU → product id.
   */
  async goalData(items: Item[], lang: Lang, goal: Goal, duration: Duration, kind: string): Promise<{ data: GoalData; refs: Map<string, string> }> {
    const [subs, rows, evidence] = await Promise.all([
      this.prisma.substances.findMany({ where: { enabled: true }, select: { id: true, name_ru: true, name_uz: true, parent_id: true } }),
      this.prisma.products.findMany({
        where: { id: { in: items.map((i) => i.product_id) } },
        select: { id: true, sku: true, name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true, substance_form_ru: true, substance_form_uz: true, substances: { select: { substance_id: true } } },
      }),
      this.prisma.goal_evidence.findMany({ where: { goal, status: 'approved' } }),
    ]);
    const names = new Map(subs.map((s) => [s.id, s]));
    const parentOf = new Map(subs.map((s) => [s.id, s.parent_id]));
    const name = (id: string) => {
      const n = names.get(id);
      return n ? (lang === 'uz' ? `${n.name_uz} (${n.name_ru})` : n.name_ru) : id;
    };
    const byId = new Map(rows.map((p) => [p.id, p]));
    const cart = items.map((i) => byId.get(i.product_id)).filter((p): p is NonNullable<typeof p> => !!p);
    const data: GoalData = {
      lang,
      goal,
      duration,
      kind,
      cart: cart.map((p) => {
        const own = p.substances.map((x) => x.substance_id).filter((id) => names.has(id));
        const all = withParents(own, parentOf);
        const lines: GoalEvidenceLine[] = evidence
          .filter((e) => all.has(e.substance_id))
          .map((e) => ({ substance: name(e.substance_id), level: e.level as Level, helps: lang === 'uz' ? e.helps_uz : e.helps_ru, not_helps: lang === 'uz' ? e.not_helps_uz : e.not_helps_ru }));
        return {
          ref: p.sku,
          name: productTitle(p, lang),
          substances: own.map(name),
          form: (lang === 'uz' ? p.substance_form_uz || p.substance_form_ru : p.substance_form_ru) ?? null,
          evidence: lines,
        };
      }),
    };
    return { data, refs: new Map(cart.map((p) => [p.sku, p.id])) };
  }
}

// ---------------- «База знаний AI → Цели» (admin) ----------------

type EvidenceStatus = 'draft' | 'approved' | 'off';

/**
 * Шаг 0б (D-69): the table «вещество → цель» is filled and approved by the doctor. As with the rules (3.8), only a role
 * with compat.rules.approve approves; a specialist's change of an approved row sends it back to «черновик».
 */
@Injectable()
export class GoalEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.goal_evidence.findMany({
      include: { substance: { select: { id: true, name_ru: true } }, approver: { select: { name: true } } },
      orderBy: [{ goal: 'asc' }, { created_at: 'asc' }],
    });
    const order: Record<string, number> = { draft: 0, approved: 1, off: 2 };
    return rows
      .sort((a, b) => order[a.status] - order[b.status] || GOALS.indexOf(a.goal as Goal) - GOALS.indexOf(b.goal as Goal))
      .map((r) => ({
        id: r.id,
        substance: r.substance,
        goal: r.goal as Goal,
        level: r.level as Level,
        helps_ru: r.helps_ru,
        helps_uz: r.helps_uz,
        not_helps_ru: r.not_helps_ru,
        not_helps_uz: r.not_helps_uz,
        source: r.source,
        status: r.status as EvidenceStatus,
        approved_by: r.approver?.name ?? null,
        approved_at: r.approved_at,
        updated_at: r.updated_at,
      }));
  }

  private async checkUnique(substanceId: string, goal: string, exceptId?: string) {
    const sub = await this.prisma.substances.findUnique({ where: { id: substanceId } });
    if (!sub) throw new BadRequestException({ code: 'NO_SUBSTANCE', message: 'Substance not found' });
    const twin = await this.prisma.goal_evidence.findFirst({ where: { substance_id: substanceId, goal, ...(exceptId && { id: { not: exceptId } }) } });
    if (twin) throw new HttpException({ code: 'ALREADY_EXISTS', message: 'This substance already has a row for this goal' }, HttpStatus.CONFLICT);
  }

  async create(me: staff_users, dto: GoalEvidenceDto) {
    await this.checkUnique(dto.substance_id, dto.goal);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.goal_evidence.create({
        data: {
          substance_id: dto.substance_id,
          goal: dto.goal,
          level: dto.level,
          helps_ru: dto.helps_ru.trim(),
          helps_uz: dto.helps_uz.trim(),
          not_helps_ru: dto.not_helps_ru.trim(),
          not_helps_uz: dto.not_helps_uz.trim(),
          source: dto.source?.trim() || null,
          created_by: me.id,
        },
      });
      await this.audit.log({ staffId: me.id, action: 'compat.goal_created', entityType: 'goal_evidence', entityId: r.id, after: r }, tx);
    });
    return this.list();
  }

  async update(me: staff_users, id: string, dto: Partial<GoalEvidenceDto>) {
    const before = await this.prisma.goal_evidence.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Row not found');
    const substance = dto.substance_id ?? before.substance_id;
    const goal = dto.goal ?? before.goal;
    if (substance !== before.substance_id || goal !== before.goal) await this.checkUnique(substance, goal, id);
    const backToDraft = before.status === 'approved' && !can(me.role, 'compat.rules.approve');
    const text = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.goal_evidence.update({
        where: { id },
        data: {
          substance_id: substance,
          goal,
          ...(dto.level && { level: dto.level }),
          ...(text(dto.helps_ru) && { helps_ru: text(dto.helps_ru) }),
          ...(text(dto.helps_uz) && { helps_uz: text(dto.helps_uz) }),
          ...(text(dto.not_helps_ru) && { not_helps_ru: text(dto.not_helps_ru) }),
          ...(text(dto.not_helps_uz) && { not_helps_uz: text(dto.not_helps_uz) }),
          ...(dto.source !== undefined && { source: dto.source?.trim() || null }),
          ...(backToDraft && { status: 'draft', approved_by: null, approved_at: null }),
        },
      });
      await this.audit.log({ staffId: me.id, action: 'compat.goal_updated', entityType: 'goal_evidence', entityId: id, before, after }, tx);
    });
    return this.list();
  }

  async setStatus(me: staff_users, id: string, status: EvidenceStatus, now = new Date()) {
    if (status === 'approved' && !can(me.role, 'compat.rules.approve')) throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: 'Only an admin approves rows' });
    const before = await this.prisma.goal_evidence.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Row not found');
    if (before.status !== status) {
      await this.prisma.$transaction(async (tx) => {
        await tx.goal_evidence.update({ where: { id }, data: status === 'approved' ? { status, approved_by: me.id, approved_at: now } : { status, approved_by: null, approved_at: null } });
        await this.audit.log({ staffId: me.id, action: `compat.goal_${status}`, entityType: 'goal_evidence', entityId: id, before: { status: before.status }, after: { status } }, tx);
      });
    }
    return this.list();
  }
}

// ---------------- DTOs and controllers ----------------

export class GoalQuestionDto {
  @ApiProperty({ enum: GOALS }) @IsIn([...GOALS]) goal!: Goal;
  @ApiProperty({ enum: DURATIONS }) @IsIn([...DURATIONS]) duration!: Duration;
  @ApiProperty({ example: 'fall_asleep', description: 'Один из вариантов цели (KINDS)' }) @IsIn([...new Set(Object.values(KINDS).flat())]) kind!: string;
}

export class GoalEvidenceDto {
  @ApiProperty() @IsUUID() substance_id!: string;
  @ApiProperty({ enum: GOALS }) @IsIn([...GOALS]) goal!: Goal;
  @ApiProperty({ enum: LEVELS }) @IsIn([...LEVELS]) level!: Level;
  @ApiProperty() @IsString() @MaxLength(400) helps_ru!: string;
  @ApiProperty() @IsString() @MaxLength(400) helps_uz!: string;
  @ApiProperty() @IsString() @MaxLength(400) not_helps_ru!: string;
  @ApiProperty() @IsString() @MaxLength(400) not_helps_uz!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) source?: string | null;
}

export class GoalEvidencePatch {
  @ApiPropertyOptional() @IsOptional() @IsUUID() substance_id?: string;
  @ApiPropertyOptional({ enum: GOALS }) @IsOptional() @IsIn([...GOALS]) goal?: Goal;
  @ApiPropertyOptional({ enum: LEVELS }) @IsOptional() @IsIn([...LEVELS]) level?: Level;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) helps_ru?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) helps_uz?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) not_helps_ru?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) not_helps_uz?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) source?: string | null;
}

export class GoalEvidenceStatusDto {
  @ApiProperty({ enum: ['draft', 'approved', 'off'] }) @IsIn(['draft', 'approved', 'off']) status!: EvidenceStatus;
}

@ApiTags('compat')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('compat/ai')
export class AiGoalController {
  constructor(private readonly goal: AiGoalService) {}

  @Post('goal')
  @HttpCode(200)
  ask(@CurrentAuth() auth: AuthContext, @Body() dto: GoalQuestionDto) {
    return this.goal.ask(auth.user.id, dto);
  }
}

@ApiTags('staff: compat')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/compat/goals')
export class AdminGoalEvidenceController {
  constructor(private readonly goals: GoalEvidenceService) {}

  @Get()
  @RequirePermission('compat.view')
  list() {
    return this.goals.list();
  }

  @Post()
  @RequirePermission('compat.answer')
  create(@CurrentStaff() me: StaffContext, @Body() dto: GoalEvidenceDto) {
    return this.goals.create(me.staff, dto);
  }

  @Patch(':id')
  @RequirePermission('compat.answer')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: GoalEvidencePatch) {
    return this.goals.update(me.staff, id, dto);
  }

  /** «Одобрить» needs compat.rules.approve (admin only); «Выключить» / «В черновик» — compat.answer. */
  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  status(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: GoalEvidenceStatusDto) {
    return this.goals.setStatus(me.staff, id, dto.status);
  }
}

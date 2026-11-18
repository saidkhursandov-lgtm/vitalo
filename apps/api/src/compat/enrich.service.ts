import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, type staff_users } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { SETTING_AI, costUsd, inLanguage, mergeAiSettings, tashkentMonthStart, type AiSettings } from './ai';
import { AI_MODEL, AiCallError, type AiModel } from './ai-client';
import { ENRICH_SCHEMA, ENRICH_SYSTEM, ENRICH_TEXTS, checkEnrichAnswer, enrichDataBlock, mergeEnrichment, type EnrichPayload, type EnrichTexts } from './enrich';
import { writeProductSubstances } from './substance-label';


const MAX_TOKENS = 3000;
/** «Добавить из iHerb»: a multivitamin has 20–30 substances, 3000 tokens is not enough for them. */
const DRAFT_MAX_TOKENS = 8000;
/** «Обогатить все»: this many products are asked at once */
const BATCH_PARALLEL = 3;

type Trigger = 'manual' | 'batch' | 'auto';

/** Marks the draft a card save accepted (ProductEdit sends its id with the product). */
export async function markEnrichmentAccepted(tx: Prisma.TransactionClient, id: string, productId: string, staffId: string | null, now = new Date()) {
  await tx.product_enrichments.updateMany({ where: { id, product_id: productId, status: 'pending' }, data: { status: 'accepted', decided_by: staffId, decided_at: now } });
}

/** Why no draft was made — the admin shows it in words. */
export class EnrichUnavailable extends HttpException {
  constructor(code: 'AI_DISABLED' | 'AI_NO_KEY' | 'AI_BUDGET' | 'AI_FAILED' | 'AI_EMPTY', message: string) {
    super({ code, message }, code === 'AI_FAILED' ? HttpStatus.BAD_GATEWAY : HttpStatus.CONFLICT);
  }
}

const TRANSLATE_SYSTEM = `Ты переводчик магазина БАДов VITALO. Переведи текст с русского на современный узбекский язык латиницей
(без кириллицы), на «siz», простыми словами, сохраняя смысл, числа, единицы и названия товаров и брендов как есть.
Ничего не добавляй от себя. Ответ — строго JSON по схеме.`;
const TRANSLATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } as const;

/**
 * VITALO AI, ветка 1: drafts of the substances, doses, audience and goals of products (enrich.ts) and the one-click
 * translation RU → UZ for the knowledge base. Every call counts in the monthly AI budget (ai_requests, no customer).
 */
@Injectable()
export class EnrichService {
  private readonly logger = new Logger(EnrichService.name);
  private batch: { running: boolean; total: number; done: number; failed: number; started_at: Date | null } = { running: false, total: 0, done: 0, failed: 0, started_at: null };

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(AI_MODEL) private readonly model: AiModel,
  ) {}

  private async settings(): Promise<AiSettings> {
    const row = await this.prisma.settings.findUnique({ where: { key: SETTING_AI } });
    return mergeAiSettings(row?.value);
  }

  /** VITALO AI is on, the key is there and the month's budget is not spent (also «Добавить из iHerb»). */
  async assertCanCall(now: Date): Promise<AiSettings> {
    const s = await this.settings();
    if (!s.enabled) throw new EnrichUnavailable('AI_DISABLED', 'VITALO AI выключен в настройках');
    if (!this.model.ready()) throw new EnrichUnavailable('AI_NO_KEY', 'Нет ключа Claude API на сервере');
    const agg = await this.prisma.ai_requests.aggregate({ _sum: { cost_usd: true }, where: { created_at: { gte: tashkentMonthStart(now) } } });
    if (Number(agg._sum.cost_usd ?? 0) >= s.monthly_budget_usd) throw new EnrichUnavailable('AI_BUDGET', 'Месячный бюджет VITALO AI исчерпан');
    return s;
  }

  async dict() {
    return this.prisma.substances.findMany({
      orderBy: [{ sort_order: 'asc' }, { name_ru: 'asc' }],
      select: { id: true, code: true, kind: true, name_ru: true, name_uz: true, synonyms: true, parent_id: true, enabled: true },
    });
  }

  /**
   * One call to the model with its line in «Расход AI» (ai_requests): `check` turns the answer into a value or an
   * error name. A call that fails → AI_FAILED. Returns the cost of the call too.
   */
  async callLogged<T>(
    q: { scenario: string; setKey: string | null; model: string; system: string; data: string; schema: Record<string, unknown>; maxTokens: number; timeoutMs?: number },
    check: (json: unknown) => { ok: true; value: T } | { ok: false; error: string },
  ): Promise<{ ok: true; value: T; cost_usd: number } | { ok: false; error: string; cost_usd: number }> {
    const started = Date.now();
    const log = { scenario: q.scenario, user_id: null, set_key: q.setKey, lang: 'ru', model: q.model };
    let completion;
    try {
      completion = await this.model.complete({ model: q.model, system: q.system, data: q.data, schema: q.schema, maxTokens: q.maxTokens, timeoutMs: q.timeoutMs });
    } catch (e) {
      const code = e instanceof AiCallError ? e.code : 'error';
      await this.prisma.ai_requests.create({ data: { ...log, status: code === 'timeout' ? 'timeout' : 'error', latency_ms: Date.now() - started, error: code } });
      throw new EnrichUnavailable('AI_FAILED', `Claude API не ответил (${code}), попробуйте ещё раз`);
    }
    const checked = completion.outcome === 'ok' ? check(completion.json) : ({ ok: false, error: completion.outcome } as const);
    const cost = costUsd(q.model, completion.inputTokens, completion.outputTokens);
    await this.prisma.ai_requests.create({
      data: {
        ...log,
        status: checked.ok ? 'ok' : 'invalid',
        input_tokens: completion.inputTokens,
        output_tokens: completion.outputTokens,
        cost_usd: new Prisma.Decimal(cost.toFixed(6)),
        latency_ms: Date.now() - started,
        error: checked.ok ? null : checked.error,
      },
    });
    return checked.ok ? { ok: true, value: checked.value, cost_usd: cost } : { ok: false, error: checked.error, cost_usd: cost };
  }

  /** The substances draft of card texts that are not a product yet («Добавить из iHerb»); payload null — none found. */
  async draftFromTexts(texts: EnrichTexts, setKey: string, s: AiSettings) {
    const dict = await this.dict();
    const r = await this.callLogged(
      { scenario: 'enrich', setKey, model: s.model, system: ENRICH_SYSTEM, data: enrichDataBlock(texts, dict), schema: ENRICH_SCHEMA as never, maxTokens: DRAFT_MAX_TOKENS },
      (json) => {
        const c = checkEnrichAnswer(json, dict);
        return c.ok ? { ok: true, value: c.payload } : c;
      },
    );
    // the card is already paid for: a failed substances answer does not lose it, the person picks substances by hand
    return { payload: r.ok ? r.value : null, failed: !r.ok && r.error !== 'empty', cost_usd: r.cost_usd };
  }

  /** One product → a new pending draft (an older pending one becomes «stale»). */
  async enrichOne(productId: string, trigger: Trigger, staffId: string | null, now = new Date()) {
    const s = await this.assertCanCall(now);
    const product = await this.prisma.products.findUnique({
      where: { id: productId },
      select: { id: true, servings_per_day: true, pack_count: true, ...Object.fromEntries(ENRICH_TEXTS.map((k) => [k, true])) } as Prisma.productsSelect & { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    const dict = await this.dict();
    const r = await this.callLogged(
      { scenario: 'enrich', setKey: productId, model: s.model, system: ENRICH_SYSTEM, data: enrichDataBlock(product as never, dict), schema: ENRICH_SCHEMA as never, maxTokens: MAX_TOKENS },
      (json) => {
        const c = checkEnrichAnswer(json, dict);
        return c.ok ? { ok: true, value: c.payload } : c;
      },
    );
    if (!r.ok) throw new EnrichUnavailable(r.error === 'empty' ? 'AI_EMPTY' : 'AI_FAILED', r.error === 'empty' ? 'AI не нашёл в тексте карточки действующих веществ' : 'AI ответил не по форме, попробуйте ещё раз');
    const checked = { payload: r.value };
    return this.prisma.$transaction(async (tx) => {
      await tx.product_enrichments.updateMany({ where: { product_id: productId, status: 'pending' }, data: { status: 'stale', decided_at: now } });
      return tx.product_enrichments.create({
        data: { product_id: productId, payload: checked.payload as unknown as Prisma.InputJsonValue, model: s.model, trigger, created_by: staffId },
        select: { id: true, payload: true, trigger: true, created_at: true },
      });
    });
  }

  /** After a new product or a changed composition: a draft in the background; failures are only logged. */
  queue(productId: string, trigger: Trigger, staffId: string | null) {
    if (process.env.NODE_ENV === 'test' || !this.model.ready()) return;
    setImmediate(() => {
      this.enrichOne(productId, trigger, staffId).catch((e) => this.logger.warn(`VITALO AI draft for ${productId} not made: ${e instanceof HttpException ? JSON.stringify(e.getResponse()) : String(e)}`));
    });
  }

  /** «Заполнить пустое»: products with gaps and no pending draft; «Перепроверить все»: every product. In the background. */
  async enrichAll(staffId: string, onlyMissing: boolean, now = new Date()) {
    if (this.batch.running) throw new HttpException({ code: 'BATCH_RUNNING', message: 'Обогащение уже идёт' }, HttpStatus.CONFLICT);
    await this.assertCanCall(now);
    const rows = await this.prisma.products.findMany({
      where: {
        status: { not: 'archived' },
        // «Перепроверить все» replaces pending drafts too (enrichOne marks the old one stale)
        ...(onlyMissing && { enrichments: { none: { status: 'pending' } } }),
        ...(onlyMissing && { OR: [{ substances: { none: {} } }, { goals: { isEmpty: true } }, { audience: null }, { substances: { some: { dose_amount: null } } }] }),
      },
      orderBy: { sku: 'asc' },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    this.batch = { running: true, total: ids.length, done: 0, failed: 0, started_at: now };
    void this.runBatch(ids, staffId);
    return this.progress();
  }

  private async runBatch(ids: string[], staffId: string) {
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          await this.enrichOne(id, 'batch', staffId);
        } catch (e) {
          this.batch.failed++;
          // budget or switched off: stop the whole batch
          const code = e instanceof HttpException ? (e.getResponse() as { code?: string }).code : null;
          if (code === 'AI_BUDGET' || code === 'AI_DISABLED' || code === 'AI_NO_KEY') queue.length = 0;
        }
        this.batch.done++;
      }
    };
    try {
      await Promise.all(Array.from({ length: BATCH_PARALLEL }, worker));
    } finally {
      this.batch.running = false;
    }
  }

  progress() {
    return { ...this.batch };
  }

  /** Pending drafts with what the product has now (the «Товары и вещества» tab). */
  async pending() {
    const rows = await this.prisma.product_enrichments.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        payload: true,
        trigger: true,
        created_at: true,
        product: {
          select: {
            id: true,
            sku: true,
            name_ru: true,
            short_name_ru: true,
            audience: true,
            goals: true,
            substances: { orderBy: [{ position: 'asc' }, { created_at: 'asc' }], select: { substance_id: true, dose_amount: true, dose_unit: true, substance: { select: { name_ru: true } } } },
          },
        },
      },
    });
    return {
      progress: this.progress(),
      drafts: rows.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        created_at: r.created_at,
        payload: r.payload as unknown as EnrichPayload,
        product: {
          id: r.product.id,
          sku: r.product.sku,
          name: r.product.short_name_ru || r.product.name_ru,
          audience: r.product.audience,
          goals: r.product.goals,
          substances: r.product.substances.map((s) => ({ id: s.substance_id, name_ru: s.substance.name_ru, dose_amount: s.dose_amount == null ? null : Number(s.dose_amount), dose_unit: s.dose_unit })),
        },
      })),
    };
  }

  /** «Принять» in the list: each draft is merged into its product (enrich.ts mergeEnrichment), one transaction each. */
  async accept(me: staff_users, ids: string[], now = new Date()) {
    const drafts = await this.prisma.product_enrichments.findMany({ where: { id: { in: ids }, status: 'pending' } });
    const dict = await this.dict();
    const parentOf = new Map(dict.map((d) => [d.id, d.parent_id]));
    const names = new Map(dict.map((d) => [d.id, { name_ru: d.name_ru, name_uz: d.name_uz }]));
    let accepted = 0;
    for (const d of drafts) {
      const payload = d.payload as unknown as EnrichPayload;
      await this.prisma.$transaction(async (tx) => {
        const product = await tx.products.findUniqueOrThrow({
          where: { id: d.product_id },
          select: { audience: true, goals: true, substances: { orderBy: [{ position: 'asc' }, { created_at: 'asc' }], select: { substance_id: true, in_label: true, dose_amount: true, dose_unit: true } } },
        });
        const current = product.substances.map((s) => ({ id: s.substance_id, in_label: s.in_label, dose_amount: s.dose_amount == null ? null : Number(s.dose_amount), dose_unit: s.dose_unit }));
        const known = new Set(dict.filter((x) => x.enabled).map((x) => x.id));
        const merged = mergeEnrichment(current, { ...payload, substances: payload.substances.filter((s) => known.has(s.id)) }, parentOf, names);
        const r = await writeProductSubstances(tx, d.product_id, merged, { clearLabel: false });
        const goals = [...new Set([...product.goals, ...payload.goals])];
        await tx.products.update({ where: { id: d.product_id }, data: { audience: product.audience ?? payload.audience, goals } });
        await markEnrichmentAccepted(tx, d.id, d.product_id, me.id, now);
        await this.audit.log(
          {
            staffId: me.id,
            action: 'compat.enrichment_accepted',
            entityType: 'product',
            entityId: d.product_id,
            before: { substances: current, audience: product.audience, goals: product.goals },
            after: { substances: merged, audience: product.audience ?? payload.audience, goals, label: r.label, enrichment_id: d.id },
          },
          tx,
        );
      });
      accepted++;
    }
    return { accepted, ...(await this.pending()) };
  }

  async reject(me: staff_users, ids: string[], now = new Date()) {
    const res = await this.prisma.product_enrichments.updateMany({ where: { id: { in: ids }, status: 'pending' }, data: { status: 'rejected', decided_by: me.id, decided_at: now } });
    return { rejected: res.count, ...(await this.pending()) };
  }

  /** «Перевести на узбекский» next to a Russian field of the knowledge base. */
  async translate(text: string, now = new Date()) {
    const s = await this.assertCanCall(now);
    const started = Date.now();
    const log = { scenario: 'translate', user_id: null, lang: 'uz', model: s.model };
    let completion;
    try {
      completion = await this.model.complete({ model: s.model, system: TRANSLATE_SYSTEM, data: text, schema: TRANSLATE_SCHEMA as never, maxTokens: 2000 });
    } catch (e) {
      const code = e instanceof AiCallError ? e.code : 'error';
      await this.prisma.ai_requests.create({ data: { ...log, status: code === 'timeout' ? 'timeout' : 'error', latency_ms: Date.now() - started, error: code } });
      throw new EnrichUnavailable('AI_FAILED', `Claude API не ответил (${code}), попробуйте ещё раз`);
    }
    const out = completion.outcome === 'ok' && typeof (completion.json as { text?: unknown })?.text === 'string' ? (completion.json as { text: string }).text.trim() : '';
    const ok = out.length > 0 && inLanguage(out, 'uz');
    await this.prisma.ai_requests.create({
      data: {
        ...log,
        status: ok ? 'ok' : 'invalid',
        input_tokens: completion.inputTokens,
        output_tokens: completion.outputTokens,
        cost_usd: new Prisma.Decimal(costUsd(s.model, completion.inputTokens, completion.outputTokens).toFixed(6)),
        latency_ms: Date.now() - started,
        error: ok ? null : 'not_uz',
      },
    });
    if (!ok) throw new EnrichUnavailable('AI_FAILED', 'Перевод не получился (не узбекская латиница), попробуйте ещё раз');
    return { text: out };
  }
}

// ---------------- DTOs ----------------

class EnrichAllDto {
  @ApiPropertyOptional({ description: 'Только товары без веществ, доз, аудитории или целей' }) @IsOptional() @IsBoolean() only_missing?: boolean;
}

class EnrichIdsDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsUUID('all', { each: true }) ids!: string[];
}

class TranslateDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(3000) text!: string;
  @ApiPropertyOptional({ enum: ['uz'] }) @IsOptional() @IsIn(['uz']) to?: 'uz';
}

// ---------------- controller ----------------

@ApiTags('staff: compat')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/compat')
export class AdminEnrichController {
  constructor(private readonly enrich: EnrichService) {}

  /** «Заполнить с помощью AI» in the product card: a new draft of this product. */
  @Post('products/:id/enrich')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  one(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.enrich.enrichOne(id, 'manual', me.staff.id);
  }

  @Post('products/enrich-all')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  all(@CurrentStaff() me: StaffContext, @Body() dto: EnrichAllDto) {
    return this.enrich.enrichAll(me.staff.id, dto.only_missing ?? true);
  }

  @Get('enrichments')
  @RequirePermission('compat.view')
  pending() {
    return this.enrich.pending();
  }

  @Post('enrichments/accept')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  accept(@CurrentStaff() me: StaffContext, @Body() dto: EnrichIdsDto) {
    return this.enrich.accept(me.staff, dto.ids);
  }

  @Post('enrichments/reject')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  reject(@CurrentStaff() me: StaffContext, @Body() dto: EnrichIdsDto) {
    return this.enrich.reject(me.staff, dto.ids);
  }

  @Post('translate')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  translate(@Body() dto: TranslateDto) {
    if (!dto.text.trim()) throw new BadRequestException({ code: 'EMPTY', message: 'Пустой текст' });
    return this.enrich.translate(dto.text.trim());
  }
}

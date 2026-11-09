import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, validate } from 'class-validator';
import { tashkentDateString } from '../common/tashkent';
import { tashkentMonthStart } from '../compat/ai';
import { CompetitorPriceInput, CompetitorsService } from '../iherb/competitors';
import { IherbPricesService } from '../iherb/iherb-prices';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { ADMIN_AI_MODEL, AdminAiCallError, type AdminAiAnswer, type AdminAiModel } from './admin-ai-client';
import {
  ADMIN_AI_MODELS,
  ADMIN_MODEL_PRICES,
  adminCostUsd,
  CHAT_SYSTEM,
  checkFeedRows,
  FACT_LABELS,
  FEED_SCHEMA,
  FEED_SYSTEM,
  feedContext,
  mergeAdminAiSettings,
  SETTING_ADMIN_AI,
  type AdminAiSettings,
  type FeedProduct,
  type FeedRow,
} from './admin-ai';

const MAX_FEED_CHARS = 100_000;
const MAX_QUESTION_CHARS = 4000;
/** Earlier questions and answers sent with a new question (the chat remembers the conversation). */
const CHAT_HISTORY = 6;
const MEMORY_IN_CONTEXT = 300;
const SALES_DAYS = 30;

export class AdminAiSettingsInput {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ enum: ADMIN_AI_MODELS }) @IsOptional() @IsIn([...ADMIN_AI_MODELS]) model?: string;
  @ApiPropertyOptional({ description: 'Бюджет в месяц, $' }) @IsOptional() @IsNumber() @Min(0) @Max(10_000) monthly_budget_usd?: number;
}

export class FeedInput {
  @ApiProperty({ description: 'Сырой текст или таблица' }) @IsString() @MinLength(1) @MaxLength(MAX_FEED_CHARS) text!: string;
}

export class FeedSaveInput {
  @ApiProperty({ type: [Number], description: 'Номера строк предпросмотра, которые сохранить' }) @IsArray() @ArrayMaxSize(200) @IsInt({ each: true }) @Min(0, { each: true }) indexes!: number[];
}

export class ChatInput {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(MAX_QUESTION_CHARS) question!: string;
}

export class FactInput {
  @ApiProperty({ enum: ['decision', 'note'] }) @IsIn(['decision', 'note']) kind!: 'decision' | 'note';
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() product_id?: string | null;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(2000) text!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) observed_on?: string;
}

export class MemoryQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() product_id?: string;
}

const money = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')}`);

/**
 * Генплан, этап 5, ветка admin-ai-analyst (D-57, узел 5): the admin AI analyst. «Загрузить данные» — the model reads
 * the owner's text, our code checks it («1-в-1»), the owner presses «Сохранить»; «Чат» — answers from the shop data,
 * the purchase signals and the long memory; every call is logged with its cost and stops at the monthly budget.
 */
@Injectable()
export class AdminAiService {
  private readonly logger = new Logger(AdminAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly competitors: CompetitorsService,
    private readonly iherb: IherbPricesService,
    @Inject(ADMIN_AI_MODEL) private readonly model: AdminAiModel,
  ) {}

  async getSettings(): Promise<AdminAiSettings> {
    return mergeAdminAiSettings(await this.settings.get(SETTING_ADMIN_AI));
  }

  async setSettings(staffId: string, input: AdminAiSettingsInput): Promise<AdminAiSettings> {
    const before = await this.getSettings();
    const value = mergeAdminAiSettings({ ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) });
    const json = value as unknown as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.settings.upsert({ where: { key: SETTING_ADMIN_AI }, create: { key: SETTING_ADMIN_AI, value: json }, update: { value: json } });
      await this.audit.log({ staffId, action: 'settings.admin_ai_updated', entityType: 'settings', before, after: value }, tx);
    });
    return value;
  }

  private async spentThisMonth(now = new Date()): Promise<number> {
    const agg = await this.prisma.admin_ai_requests.aggregate({ _sum: { cost_usd: true }, where: { created_at: { gte: tashkentMonthStart(now) } } });
    return Number(agg._sum.cost_usd ?? 0);
  }

  async status() {
    const [s, spent] = await Promise.all([this.getSettings(), this.spentThisMonth()]);
    return {
      settings: s,
      key_set: this.model.ready(),
      spent_month_usd: Math.round(spent * 10000) / 10000,
      models: ADMIN_AI_MODELS.map((id) => ({ id, ...ADMIN_MODEL_PRICES[id] })),
    };
  }

  /** Off, no key or no money left: a clear message instead of a call. */
  private async guard(): Promise<AdminAiSettings> {
    const s = await this.getSettings();
    if (!s.enabled) throw new ConflictException({ code: 'ADMIN_AI_DISABLED', message: 'AI-аналитик выключен в настройках' });
    if (!this.model.ready()) throw new ConflictException({ code: 'ADMIN_AI_NO_KEY', message: 'Нет ключа ANTHROPIC_ADMIN_API_KEY в файле настроек .env' });
    if ((await this.spentThisMonth()) >= s.monthly_budget_usd) throw new ConflictException({ code: 'ADMIN_AI_BUDGET', message: 'Бюджет AI-аналитика на этот месяц исчерпан' });
    return s;
  }

  /** One call to the model, always written to «Журнал запросов» (also when it fails). */
  private async call(staffId: string, scenario: 'feed' | 'chat', question: string, run: () => Promise<AdminAiAnswer>, model: string) {
    const started = Date.now();
    try {
      const a = await run();
      const cost = adminCostUsd(a);
      const req = await this.prisma.admin_ai_requests.create({
        data: {
          staff_user_id: staffId,
          scenario,
          model: a.model,
          question: question.slice(0, MAX_QUESTION_CHARS),
          answer: scenario === 'chat' ? a.text : null,
          input_tokens: a.inputTokens,
          output_tokens: a.outputTokens,
          cache_read_tokens: a.cacheReadTokens,
          cache_write_tokens: a.cacheWriteTokens,
          cost_usd: new Prisma.Decimal(cost.toFixed(6)),
          outcome: a.outcome,
          latency_ms: Date.now() - started,
        },
      });
      return { answer: a, request: req };
    } catch (e) {
      const code = e instanceof AdminAiCallError ? e.code : 'error';
      if (!(e instanceof AdminAiCallError)) this.logger.error('Admin AI call failed', e as Error);
      await this.prisma.admin_ai_requests.create({
        data: { staff_user_id: staffId, scenario, model, question: question.slice(0, MAX_QUESTION_CHARS), outcome: 'error', error_code: code, latency_ms: Date.now() - started },
      });
      throw new HttpException({ code: 'ADMIN_AI_FAILED', message: `Claude не ответил (${code}). Попробуйте ещё раз через минуту.`, reason: code }, HttpStatus.BAD_GATEWAY);
    }
  }

  // ---------------- «Загрузить данные» ----------------

  private async feedProducts(): Promise<FeedProduct[]> {
    const list = await this.prisma.products.findMany({
      where: { status: { not: 'archived' } },
      orderBy: { sku: 'asc' },
      select: { id: true, sku: true, name_ru: true, brand: true, match_form: true, dose_amount: true, dose_unit: true, dose_per: true, pack_count: true },
    });
    return list.map((p) => ({ ...p, dose_amount: p.dose_amount == null ? null : Number(p.dose_amount) }));
  }

  /** «Проверить»: the model reads the text, our code checks it; saved as «Что я прислал», nothing else is written. */
  async feed(staffId: string, text: string) {
    const raw = text.trim();
    if (!raw) throw new BadRequestException({ code: 'ADMIN_AI_EMPTY', message: 'Вставьте текст или таблицу' });
    const s = await this.guard();
    const products = await this.feedProducts();
    const today = tashkentDateString(new Date());
    const context = feedContext(
      products.map((p) => ({ sku: p.sku, name_ru: p.name_ru, brand: p.brand ?? '', match_form: p.match_form, dose: p.dose_amount != null ? `${p.dose_amount} ${p.dose_unit} / ${p.dose_per}` : null, pack_count: p.pack_count })),
      today,
    );
    let res: Awaited<ReturnType<AdminAiService['call']>>;
    try {
      res = await this.call(
        staffId,
        'feed',
        raw.slice(0, 300),
        () => this.model.ask({ model: s.model, system: FEED_SYSTEM, context, messages: [{ role: 'user', content: raw }], schema: FEED_SCHEMA, maxTokens: 16000, effort: 'medium' }),
        s.model,
      );
    } catch (e) {
      await this.prisma.admin_ai_feed.create({ data: { staff_user_id: staffId, raw_text: raw, status: 'failed', error_code: 'call_failed' } });
      throw e;
    }
    if (res.answer.outcome !== 'ok' || res.answer.json == null) {
      await this.prisma.admin_ai_feed.create({ data: { staff_user_id: staffId, raw_text: raw, status: 'failed', error_code: res.answer.outcome, request_id: res.request.id } });
      throw new HttpException({ code: 'ADMIN_AI_UNREADABLE', message: res.answer.outcome === 'refusal' ? 'Claude отказался разбирать этот текст' : 'Claude не смог разобрать текст — попробуйте вставить меньше за раз' }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const checked = checkFeedRows(res.answer.json, products, today);
    const feed = await this.prisma.admin_ai_feed.create({
      data: { staff_user_id: staffId, raw_text: raw, status: 'parsed', rows: { rows: checked.rows, unclear: checked.unclear } as unknown as Prisma.InputJsonValue, request_id: res.request.id },
    });
    return { id: feed.id, ...checked, cost_usd: Number(res.request.cost_usd) };
  }

  /**
   * «Сохранить»: the chosen rows of a preview. Rows come from the database (what the model read and our code checked),
   * never from the browser; competitor prices go to «Цены конкурентов» with source «ai», the rest — to the memory.
   */
  async saveFeed(staffId: string, feedId: string, indexes: number[]) {
    const feed = await this.prisma.admin_ai_feed.findUnique({ where: { id: feedId } });
    if (!feed) throw new NotFoundException({ code: 'FEED_NOT_FOUND', message: 'Загрузка не найдена' });
    if (feed.status !== 'parsed') throw new ConflictException({ code: 'FEED_NOT_OPEN', message: feed.status === 'saved' ? 'Эта загрузка уже сохранена' : 'Эту загрузку нельзя сохранить' });
    const rows = ((feed.rows as unknown as { rows?: FeedRow[] }).rows ?? []).filter((r) => indexes.includes(r.index) && !r.problem);
    if (!rows.length) throw new BadRequestException({ code: 'FEED_NOTHING_SELECTED', message: 'Отметьте строки, которые можно сохранить' });
    // the same checks as the manual form (class-validator on CompetitorPriceInput)
    const prices: { row: FeedRow; dto: CompetitorPriceInput }[] = [];
    for (const r of rows.filter((x) => x.kind === 'competitor_price')) {
      const dto = plainToInstance(CompetitorPriceInput, {
        platform: r.platform,
        seller: r.seller,
        title: r.title,
        url: r.url,
        price_uzs: r.price_uzs,
        observed_on: r.observed_on,
        brand: r.brand,
        match_form: r.match_form,
        dose_amount: r.dose_amount,
        dose_unit: r.dose_unit,
        dose_per: r.dose_per,
        pack_count: r.pack_count,
        orders_count: r.orders_count,
      });
      const errors = await validate(dto);
      if (errors.length) throw new BadRequestException({ code: 'FEED_ROW_INVALID', message: `Строка ${r.index + 1}: ${Object.values(errors[0].constraints ?? {})[0] ?? 'неверные данные'}` });
      prices.push({ row: r, dto });
    }
    return this.prisma.$transaction(
      async (tx) => {
        for (const { row, dto } of prices) await this.competitors.addTx(tx, staffId, row.product!.id, dto, 'ai');
        const facts = rows.filter((r) => r.kind !== 'competitor_price');
        for (const r of facts) {
          await tx.admin_business_memory.create({
            data: {
              kind: r.kind,
              product_id: r.product?.id ?? null,
              platform: r.platform,
              seller: r.seller,
              value_num: r.kind === 'orders' ? r.orders_count : r.kind === 'bestseller_rank' ? r.bestseller_rank : null,
              value_text: r.note ?? r.title,
              observed_on: new Date(`${r.observed_on}T00:00:00Z`),
              source: 'feed',
              feed_id: feed.id,
              staff_user_id: staffId,
            },
          });
        }
        const saved = { competitor_prices: prices.length, facts: facts.length };
        await tx.admin_ai_feed.update({ where: { id: feed.id }, data: { status: 'saved', saved, saved_at: new Date() } });
        await this.audit.log({ staffId, action: 'ai_analyst.feed_saved', entityType: 'admin_ai_feed', entityId: feed.id, after: saved }, tx);
        return { id: feed.id, ...saved };
      },
      { timeout: 60_000 },
    );
  }

  async feeds() {
    const rows = await this.prisma.admin_ai_feed.findMany({ orderBy: { created_at: 'desc' }, take: 30, include: { staff: { select: { name: true } } } });
    return rows.map(({ staff, rows: r, raw_text, ...f }) => ({
      ...f,
      staff_name: staff?.name ?? null,
      text_preview: raw_text.slice(0, 300),
      rows_count: ((r as unknown as { rows?: unknown[] }).rows ?? []).length,
    }));
  }

  async feedOne(id: string) {
    const f = await this.prisma.admin_ai_feed.findUnique({ where: { id } });
    if (!f) throw new NotFoundException({ code: 'FEED_NOT_FOUND', message: 'Загрузка не найдена' });
    const r = f.rows as unknown as { rows?: FeedRow[]; unclear?: string[] };
    return { ...f, rows: r.rows ?? [], unclear: r.unclear ?? [] };
  }

  // ---------------- «Память о бизнесе» ----------------

  async memory(productId?: string) {
    const rows = await this.prisma.admin_business_memory.findMany({
      where: { active: true, ...(productId ? { product_id: productId } : {}) },
      orderBy: [{ observed_on: 'desc' }, { created_at: 'desc' }],
      take: 500,
      include: { product: { select: { sku: true, name_ru: true } }, staff: { select: { name: true } } },
    });
    return rows.map(({ product, staff, value_num, ...m }) => ({
      ...m,
      value_num: value_num == null ? null : Number(value_num),
      observed_on: m.observed_on.toISOString().slice(0, 10),
      product_sku: product?.sku ?? null,
      product_name: product?.name_ru ?? null,
      staff_name: staff?.name ?? null,
    }));
  }

  /** A decision or a note of the owner, written by hand: the analyst takes it into account in every answer. */
  async addFact(staffId: string, d: FactInput) {
    const today = tashkentDateString(new Date());
    if (d.observed_on && d.observed_on > today) throw new BadRequestException({ code: 'DATE_IN_FUTURE', message: 'Дата не может быть позже сегодняшней' });
    if (d.product_id && !(await this.prisma.products.findUnique({ where: { id: d.product_id }, select: { id: true } }))) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Товар не найден' });
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.admin_business_memory.create({
        data: { kind: d.kind, product_id: d.product_id ?? null, value_text: d.text.trim(), observed_on: new Date(`${d.observed_on ?? today}T00:00:00Z`), source: 'manual', staff_user_id: staffId },
      });
      await this.audit.log({ staffId, action: 'ai_analyst.fact_added', entityType: 'admin_business_memory', entityId: row.id, after: { kind: row.kind, product_id: row.product_id, text: row.value_text } }, tx);
      return { id: row.id };
    });
  }

  /** «Убрать»: the fact stops counting (active = false); it stays in the database and the audit log. */
  async factOff(staffId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.admin_business_memory.findUnique({ where: { id } });
      if (!row || !row.active) throw new NotFoundException({ code: 'FACT_NOT_FOUND', message: 'Запись не найдена' });
      await tx.admin_business_memory.update({ where: { id }, data: { active: false } });
      await this.audit.log({ staffId, action: 'ai_analyst.fact_off', entityType: 'admin_business_memory', entityId: id, before: { kind: row.kind, text: row.value_text } }, tx);
      return { id, active: false };
    });
  }

  // ---------------- «Чат» ----------------

  /** The shop data for the chat: iHerb products with prices, costs, stock, sales, signals; the memory. */
  async chatContext(now = new Date()): Promise<string> {
    const [products, facts] = await Promise.all([
      this.iherb.products(),
      this.prisma.admin_business_memory.findMany({
        where: { active: true },
        orderBy: [{ observed_on: 'desc' }, { created_at: 'desc' }],
        take: MEMORY_IN_CONTEXT,
        include: { product: { select: { sku: true } } },
      }),
    ]);
    const since = new Date(now.getTime() - SALES_DAYS * 86400_000);
    const sales = products.length
      ? await this.prisma.order_items.groupBy({
          by: ['product_id'],
          where: { product_id: { in: products.map((p) => p.id) }, order: { created_at: { gte: since }, status: { not: 'cancelled' } } },
          _sum: { qty: true },
        })
      : [];
    const sold = new Map(sales.map((s) => [s.product_id, s._sum.qty ?? 0]));
    const lines = products.map((p) =>
      [
        p.sku,
        p.name_ru,
        `цена ${money(p.price_uzs)}`,
        `закупка ${money(p.cost_uzs)}`,
        `остаток ${p.available}`,
        `продано за 30 дн. ${sold.get(p.id) ?? 0}`,
        `iHerb ${money(p.last_snapshot?.price_uzs)}${p.last_snapshot && !p.last_snapshot.in_stock ? ' (нет в наличии)' : ''}`,
        `iHerb с доставкой ${money(p.iherb_landed_uzs)}`,
        `средняя 30 дн. ${money(p.avg30_uzs)} (${p.avg_days} дн.)`,
        p.last_snapshot?.bestseller_rank ? `бестселлер №${p.last_snapshot.bestseller_rank}` : p.last_snapshot?.bestseller ? 'бестселлер' : '',
        `рынок «1-в-1» от ${money(p.market_min_uzs)} (${p.competitors_count} цен)`,
        p.signals.length ? `сигналы: ${p.signals.map((s) => s.text).join('; ')}` : 'сигналов нет',
      ]
        .filter(Boolean)
        .join(' | '),
    );
    const memory = facts.map((f) =>
      [f.observed_on.toISOString().slice(0, 10), FACT_LABELS[f.kind] ?? f.kind, f.product?.sku ?? '', f.platform ?? '', f.seller ?? '', f.value_num != null ? String(Number(f.value_num)) : '', f.value_text ?? ''].filter(Boolean).join(' | '),
    );
    return [
      `Сегодня: ${tashkentDateString(now)}. Суммы в сумах.`,
      `Данные магазина — товары с ссылкой iHerb (артикул | название | …):\n${lines.join('\n') || 'нет'}`,
      `Память о бизнесе (дата | вид | артикул | площадка | продавец | число | текст):\n${memory.join('\n') || 'пусто'}`,
    ].join('\n\n');
  }

  async chat(staffId: string, question: string) {
    const q = question.trim();
    if (!q) throw new BadRequestException({ code: 'ADMIN_AI_EMPTY', message: 'Напишите вопрос' });
    const s = await this.guard();
    const [context, history] = await Promise.all([
      this.chatContext(),
      this.prisma.admin_ai_requests.findMany({ where: { staff_user_id: staffId, scenario: 'chat', outcome: 'ok', answer: { not: null } }, orderBy: { created_at: 'desc' }, take: CHAT_HISTORY }),
    ]);
    const messages = history
      .reverse()
      .flatMap((h) => [
        { role: 'user' as const, content: h.question ?? '' },
        { role: 'assistant' as const, content: h.answer ?? '' },
      ])
      .concat([{ role: 'user' as const, content: q }]);
    const res = await this.call(staffId, 'chat', q, () => this.model.ask({ model: s.model, system: CHAT_SYSTEM, context, messages, maxTokens: 16000, effort: 'medium' }), s.model);
    const text =
      res.answer.outcome === 'refusal' ? 'Claude отказался отвечать на этот вопрос. Попробуйте сформулировать иначе.' : res.answer.outcome === 'max_tokens' ? `${res.answer.text}\n\n(ответ оборван — слишком длинный)` : res.answer.text;
    return { id: res.request.id, question: q, answer: text, outcome: res.answer.outcome, cost_usd: Number(res.request.cost_usd), created_at: res.request.created_at };
  }

  async chatHistory(staffId: string) {
    const rows = await this.prisma.admin_ai_requests.findMany({ where: { staff_user_id: staffId, scenario: 'chat', outcome: { not: 'error' } }, orderBy: { created_at: 'desc' }, take: 30 });
    return rows.reverse().map((r) => ({ id: r.id, question: r.question, answer: r.answer, outcome: r.outcome, cost_usd: Number(r.cost_usd), created_at: r.created_at }));
  }

  // ---------------- «Журнал запросов» ----------------

  async requests() {
    const now = new Date();
    const [rows, month] = await Promise.all([
      this.prisma.admin_ai_requests.findMany({ orderBy: { created_at: 'desc' }, take: 50, include: { staff: { select: { name: true } } } }),
      this.prisma.admin_ai_requests.aggregate({ _sum: { cost_usd: true }, _count: true, where: { created_at: { gte: tashkentMonthStart(now) } } }),
    ]);
    return {
      month: { requests: month._count, cost_usd: Number(month._sum.cost_usd ?? 0) },
      items: rows.map(({ staff, answer, cost_usd, ...r }) => ({ ...r, question: r.question?.slice(0, 200) ?? null, has_answer: !!answer, cost_usd: Number(cost_usd), staff_name: staff?.name ?? null })),
    };
  }
}

/** AI-аналитик (admin only). */
@ApiTags('staff: ai analyst')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/ai-analyst')
export class AiAnalystController {
  constructor(private readonly ai: AdminAiService) {}

  @Get('status')
  @RequirePermission('ai_analyst.use')
  status() {
    return this.ai.status();
  }

  @Put('settings')
  @RequirePermission('ai_analyst.use')
  setSettings(@CurrentStaff() me: StaffContext, @Body() dto: AdminAiSettingsInput) {
    return this.ai.setSettings(me.staff.id, dto);
  }

  @Post('feed')
  @HttpCode(200)
  @RequirePermission('ai_analyst.use')
  feed(@CurrentStaff() me: StaffContext, @Body() dto: FeedInput) {
    return this.ai.feed(me.staff.id, dto.text);
  }

  @Get('feed')
  @RequirePermission('ai_analyst.use')
  feeds() {
    return this.ai.feeds();
  }

  @Get('feed/:id')
  @RequirePermission('ai_analyst.use')
  feedOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.ai.feedOne(id);
  }

  @Post('feed/:id/save')
  @HttpCode(200)
  @RequirePermission('ai_analyst.use')
  saveFeed(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: FeedSaveInput) {
    return this.ai.saveFeed(me.staff.id, id, dto.indexes);
  }

  @Get('memory')
  @RequirePermission('ai_analyst.use')
  memory(@Query() q: MemoryQuery) {
    return this.ai.memory(q.product_id);
  }

  @Post('memory')
  @RequirePermission('ai_analyst.use')
  addFact(@CurrentStaff() me: StaffContext, @Body() dto: FactInput) {
    return this.ai.addFact(me.staff.id, dto);
  }

  @Delete('memory/:id')
  @HttpCode(200)
  @RequirePermission('ai_analyst.use')
  factOff(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.ai.factOff(me.staff.id, id);
  }

  @Post('chat')
  @HttpCode(200)
  @RequirePermission('ai_analyst.use')
  chat(@CurrentStaff() me: StaffContext, @Body() dto: ChatInput) {
    return this.ai.chat(me.staff.id, dto.question);
  }

  @Get('chat')
  @RequirePermission('ai_analyst.use')
  chatHistory(@CurrentStaff() me: StaffContext) {
    return this.ai.chatHistory(me.staff.id);
  }

  @Get('requests')
  @RequirePermission('ai_analyst.use')
  requests() {
    return this.ai.requests();
  }
}

import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Logger, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Prisma, type ai_compat_answers, type staff_users } from '@prisma/client';
import { IsObject } from 'class-validator';
import { AnalyticsService } from '../analytics/analytics.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { availableQty } from '../catalog/product.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { productTitle } from '../waitlist/waitlist';
import {
  CART_SCHEMA,
  DEFAULT_AI_SETTINGS,
  SETTING_AI,
  SYSTEM_CART,
  SYSTEM_COMMON,
  cartDataBlock,
  checkCartAnswer,
  costUsd,
  mergeAiSettings,
  ruleFloor,
  tashkentMonthStart,
  type AiProduct,
  type AiRule,
  type AiSettings,
  type CartData,
} from './ai';
import { AI_MODEL, AiCallError, type AiModel } from './ai-client';
import { setKeyOf, tashkentDayStart, type Lang, type Verdict } from './compat';
import { CompatService, langOf, type Item } from './compat.service';
import { OVERLAP_TEXT, applyOverlapFloor, overlapsForProducts, rulesForProducts, withParents, type RuleKind, type When } from './knowledge';

/** Up to this many products in stock are offered to the model for a cart of one product. */
const CANDIDATES_MAX = 10;
const MAX_TOKENS = 4000;

type Fallback = 'off' | 'no_key' | 'budget' | 'error' | 'timeout' | 'invalid';

/** What the cart shows besides the text: when to take each product, suggestions, overlaps and medicine lines. */
export interface AiView {
  answer_id: string;
  verdict: Verdict;
  text: string;
  timing: { product_id: string; name: string; when: string }[];
  suggestions: { product_id: string; name: string }[];
  /** substances found in 2+ products of the cart (D-47) and the fixed line about them */
  overlaps: string[];
  overlap_text: string | null;
  /** approved «осторожно с лекарствами» rules for the substances of the cart — always shown (D-45) */
  drugs: string[];
}

interface Knowledge {
  names: Map<string, { ru: string; uz: string; kind: string }>;
  parentOf: Map<string, string | null>;
  rules: { id: string; substance_a_id: string; substance_b_id: string; kind: string; interval_hours: number | null; when_a: string | null; when_b: string | null; text_ru: string; text_uz: string }[];
}

/**
 * 3.8: VITALO AI in the cart (D-45, D-47). The answer comes from, in this order: a saved specialist answer for the same
 * set and language → a cached AI answer for it (made after the latest change of the rules) → a new request to the model.
 * The model gets products and approved rules only, never the customer's data. Its answer is checked before anyone sees
 * it; a failure, no key, a switched-off assistant or a spent budget hand the cart to the specialist («ai_fallback»).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  /** one check at a time per customer: a double tap does not pay twice */
  private readonly busy = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly compat: CompatService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
    @Inject(AI_MODEL) private readonly model: AiModel,
  ) {}

  async settings(): Promise<AiSettings> {
    const row = await this.prisma.settings.findUnique({ where: { key: SETTING_AI } });
    return mergeAiSettings(row?.value);
  }

  private newToday(userId: string, now: Date) {
    return this.prisma.ai_requests.count({ where: { user_id: userId, scenario: 'cart', status: 'ok', created_at: { gte: tashkentDayStart(now) } } });
  }

  private async spentThisMonth(now: Date): Promise<number> {
    const agg = await this.prisma.ai_requests.aggregate({ _sum: { cost_usd: true }, where: { created_at: { gte: tashkentMonthStart(now) } } });
    return Number(agg._sum.cost_usd ?? 0);
  }

  // ---------------- customer ----------------

  /** The cart block: whether VITALO AI works now, whether the customer agreed, new checks left today, the latest answer. */
  async state(userId: string, now = new Date()) {
    const s = await this.settings();
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { ai_consent_at: true, language: true } });
    const items = await this.compat.cartItems(userId);
    const setKey = setKeyOf(items.map((i) => i.product_id));
    const latest = await this.prisma.compat_requests.findFirst({
      where: { user_id: userId, set_key: setKey, status: 'answered', source: { in: ['ai', 'ai_cache'] } },
      orderBy: { created_at: 'desc' },
      include: { ai_answer: true },
    });
    const lang = langOf(user.language);
    return {
      available: s.enabled && this.model.ready(),
      consent: !!user.ai_consent_at,
      eligible: items.length >= 1,
      left_today: Math.max(0, s.cart_daily_limit - (await this.newToday(userId, now))),
      answer: latest?.ai_answer && latest.ai_answer.review !== 'hidden' && latest.ai_answer.lang === lang ? await this.view(latest.ai_answer, items, lang) : null,
    };
  }

  /** «Я согласен» (D-47): once; the date is kept on the customer. */
  async consent(userId: string) {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { ai_consent_at: true } });
    if (!user.ai_consent_at) {
      await this.prisma.users.update({ where: { id: userId }, data: { ai_consent_at: new Date() } });
      await this.analytics.track(userId, 'ai_consent', {});
    }
    return this.state(userId);
  }

  /**
   * «Проверить с VITALO AI». 403 CONSENT_REQUIRED, 400 NOT_ENOUGH_ITEMS (empty cart), 409 BUSY, 429 AI_DAILY_LIMIT.
   * result: instant (saved specialist answer) | ai | ai_cache | specialist (handed over) | unavailable (one product, no AI).
   */
  async check(userId: string, now = new Date()) {
    if (this.busy.has(userId)) throw new HttpException({ code: 'BUSY', message: 'The check is already running' }, HttpStatus.CONFLICT);
    this.busy.add(userId);
    try {
      return await this.runCheck(userId, now);
    } finally {
      this.busy.delete(userId);
    }
  }

  private async runCheck(userId: string, now: Date) {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { ai_consent_at: true, language: true } });
    if (!user.ai_consent_at) throw new ForbiddenException({ code: 'CONSENT_REQUIRED', message: 'The customer has not agreed to VITALO AI yet' });
    const lang = langOf(user.language);
    const items = await this.compat.cartItems(userId);
    if (!items.length) throw new BadRequestException({ code: 'NOT_ENOUGH_ITEMS', message: 'The cart is empty' });
    const setKey = setKeyOf(items.map((i) => i.product_id));

    // 1. a specialist's saved answer always wins
    if (items.length >= 2 && (await this.compat.answerFromSaved(userId, items, lang, now))) return { result: 'instant' as const, ...(await this.state(userId, now)) };

    // switched off in «Настройки → VITALO AI»: no AI answers at all, cached ones too
    const s = await this.settings();
    if (!s.enabled) return this.fallback(userId, items, lang, 'off', now);

    // 2. the same set was answered by the AI after the latest change of the knowledge base
    const cached = await this.cached(setKey, lang);
    if (cached) {
      await this.prisma.$transaction([
        this.prisma.ai_compat_answers.update({ where: { id: cached.id }, data: { used_count: { increment: 1 } } }),
        this.answeredRequest(userId, items, lang, 'ai_cache', cached, now),
      ]);
      await this.analytics.track(userId, 'compat_ai_cached', { products: items.length, verdict: cached.verdict, lang });
      return { result: 'ai_cache' as const, ...(await this.state(userId, now)) };
    }

    // 3. a new request
    if (!this.model.ready()) return this.fallback(userId, items, lang, 'no_key', now);
    if ((await this.newToday(userId, now)) >= s.cart_daily_limit) {
      await this.analytics.track(userId, 'compat_ai_limit', { scenario: 'cart', limit: s.cart_daily_limit });
      throw new HttpException({ code: 'AI_DAILY_LIMIT', message: `No more than ${s.cart_daily_limit} new checks a day` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if ((await this.spentThisMonth(now)) >= s.monthly_budget_usd) return this.fallback(userId, items, lang, 'budget', now);

    const { data, floor, refs } = await this.cartData(items, lang);
    const started = Date.now();
    const log = { scenario: 'cart', user_id: userId, set_key: setKey, lang, model: s.model };
    let completion;
    try {
      completion = await this.model.complete({ model: s.model, system: `${SYSTEM_COMMON}\n\n${SYSTEM_CART}`, data: cartDataBlock(data), schema: CART_SCHEMA, maxTokens: MAX_TOKENS });
    } catch (e) {
      const code = e instanceof AiCallError ? e.code : 'error';
      this.logger.warn(`VITALO AI cart check failed: ${code}`);
      await this.prisma.ai_requests.create({ data: { ...log, status: code === 'timeout' ? 'timeout' : 'error', latency_ms: Date.now() - started, error: code } });
      return this.fallback(userId, items, lang, code === 'timeout' ? 'timeout' : 'error', now);
    }
    const cost = costUsd(s.model, completion.inputTokens, completion.outputTokens);
    const checked = completion.outcome === 'ok' ? checkCartAnswer(completion.json, data, floor) : ({ ok: false, error: completion.outcome } as const);
    const req = await this.prisma.ai_requests.create({
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
    if (!checked.ok) return this.fallback(userId, items, lang, 'invalid', now);

    const a = checked.answer;
    const answer = await this.prisma.$transaction(async (tx) => {
      const row = await tx.ai_compat_answers.create({
        data: {
          set_key: setKey,
          product_ids: setKey.split(','),
          items: items as unknown as Prisma.InputJsonArray,
          lang,
          verdict: a.verdict,
          text: a.text,
          timing: a.timing.map((t) => ({ product_id: refs.get(t.ref)!, when: t.when })),
          suggested_ids: a.suggested.map((r) => refs.get(r)!),
          model: s.model,
          ai_request_id: req.id,
          used_count: 1,
        },
      });
      await this.answeredRequest(userId, items, lang, 'ai', row, now, tx);
      return row;
    });
    await this.analytics.track(userId, 'compat_ai_request', { products: items.length, verdict: answer.verdict, lang, latency_ms: req.latency_ms, model: s.model });
    return { result: 'ai' as const, ...(await this.state(userId, now)) };
  }

  /** An AI answer for the set that is still good: not hidden and newer than the latest change of rules and substances. */
  private async cached(setKey: string, lang: Lang) {
    const [rules, links] = await Promise.all([
      this.prisma.compat_rules.aggregate({ _max: { updated_at: true } }),
      this.prisma.product_substances.aggregate({ _max: { created_at: true } }),
    ]);
    const after = [rules._max.updated_at, links._max.created_at].filter((d): d is Date => !!d).reduce((m, d) => (d > m ? d : m), new Date(0));
    return this.prisma.ai_compat_answers.findFirst({ where: { set_key: setKey, lang, review: { not: 'hidden' }, created_at: { gt: after } }, orderBy: { created_at: 'desc' } });
  }

  private answeredRequest(userId: string, items: Item[], lang: Lang, source: 'ai' | 'ai_cache', a: ai_compat_answers, now: Date, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return db.compat_requests.create({
      data: {
        user_id: userId,
        product_ids: a.product_ids,
        set_key: a.set_key,
        items: items as unknown as Prisma.InputJsonArray,
        lang,
        status: 'answered',
        source,
        verdict: a.verdict,
        answer_text: a.text,
        answered_at: now,
        ai_answer_id: a.id,
      },
    });
  }

  /** The AI could not answer: 2+ products go to the specialist (no daily limit for this), one product — nothing to do. */
  private async fallback(userId: string, items: Item[], lang: Lang, reason: Fallback, now: Date) {
    await this.analytics.track(userId, 'compat_ai_fallback', { reason, products: items.length, lang });
    if (items.length < 2) return { result: 'unavailable' as const, reason, ...(await this.state(userId, now)) };
    const setKey = setKeyOf(items.map((i) => i.product_id));
    const pending = await this.prisma.compat_requests.findFirst({ where: { user_id: userId, status: 'pending', set_key: setKey } });
    if (!pending) await this.compat.queue(userId, items, lang, null, 'ai_fallback');
    return { result: 'specialist' as const, reason, ...(await this.state(userId, now)) };
  }

  // ---------------- what the model gets ----------------

  private async knowledge(): Promise<Knowledge> {
    const [subs, rules] = await Promise.all([
      this.prisma.substances.findMany({ where: { enabled: true }, select: { id: true, name_ru: true, name_uz: true, kind: true, parent_id: true } }),
      this.prisma.compat_rules.findMany({ where: { status: 'approved' } }),
    ]);
    return {
      names: new Map(subs.map((s) => [s.id, { ru: s.name_ru, uz: s.name_uz, kind: s.kind }])),
      parentOf: new Map(subs.map((s) => [s.id, s.parent_id])),
      rules,
    };
  }

  private async products(ids: string[]) {
    return this.prisma.products.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        sku: true,
        name_ru: true,
        name_uz: true,
        short_name_ru: true,
        short_name_uz: true,
        substance_form_ru: true,
        substance_form_uz: true,
        servings_per_day: true,
        intake_memo_ru: true,
        intake_memo_uz: true,
        doctor_verdict_ru: true,
        doctor_verdict_uz: true,
        brand: true,
        substances: { select: { substance_id: true } },
      },
    });
  }

  /**
   * The data block of a cart and the lowest label the server allows (D-47). With 2+ products the rules count only between
   * different products; with one product the model may offer up to 3 products in stock linked to it by «синергия».
   */
  async cartData(items: Item[], lang: Lang): Promise<{ data: CartData; floor: Verdict; refs: Map<string, string> }> {
    const k = await this.knowledge();
    const rows = await this.products(items.map((i) => i.product_id));
    const byId = new Map(rows.map((p) => [p.id, p]));
    const cart = items.map((i) => byId.get(i.product_id)).filter((p): p is NonNullable<typeof p> => !!p);
    const name = (id: string) => {
      const n = k.names.get(id);
      return n ? (lang === 'uz' ? `${n.uz} (${n.ru})` : n.ru) : id;
    };
    const own = (p: (typeof rows)[number]) => p.substances.map((x) => x.substance_id).filter((id) => k.names.has(id));
    const toAi = (p: (typeof rows)[number]): AiProduct => ({
      ref: p.sku,
      name: productTitle(p, lang),
      brand: p.brand || null,
      substances: own(p).map(name),
      form: (lang === 'uz' ? p.substance_form_uz || p.substance_form_ru : p.substance_form_ru) ?? null,
      servings_per_day: p.servings_per_day,
      memo: (lang === 'uz' ? p.intake_memo_uz || p.intake_memo_ru : p.intake_memo_ru) ?? null,
      verdict: (lang === 'uz' ? p.doctor_verdict_uz || p.doctor_verdict_ru : p.doctor_verdict_ru) ?? null,
    });
    const toRule = (r: Knowledge['rules'][number]): AiRule => ({
      a: name(r.substance_a_id),
      b: name(r.substance_b_id),
      kind: r.kind as RuleKind,
      interval_hours: r.interval_hours,
      when_a: r.when_a as When | null,
      when_b: r.when_b as When | null,
      text: lang === 'uz' ? r.text_uz : r.text_ru,
    });

    const withSubs = cart.map((p) => ({ id: p.id, substances: withParents(own(p), k.parentOf) }));
    const all = new Set(withSubs.flatMap((p) => [...p.substances]));
    const isDrug = (id: string) => k.names.get(id)?.kind === 'drug_group';
    const supplementRules = k.rules.filter((r) => r.kind !== 'drug_caution' && !isDrug(r.substance_a_id) && !isDrug(r.substance_b_id));
    const drugRules = k.rules.filter((r) => (all.has(r.substance_a_id) && isDrug(r.substance_b_id)) || (all.has(r.substance_b_id) && isDrug(r.substance_a_id)));

    const refs = new Map(cart.map((p) => [p.sku, p.id]));
    let rules: Knowledge['rules'] = [];
    let candidates: AiProduct[] = [];
    let floor: Verdict = 'compatible';
    if (cart.length >= 2) {
      rules = rulesForProducts(withSubs, supplementRules);
      floor = ruleFloor(rules.map((r) => r.kind as RuleKind));
    } else if (cart.length === 1) {
      const synergy = supplementRules.filter((r) => r.kind === 'synergy' && (all.has(r.substance_a_id) || all.has(r.substance_b_id)));
      const partners = new Set(synergy.flatMap((r) => [r.substance_a_id, r.substance_b_id]).filter((id) => !all.has(id)));
      if (partners.size) {
        const found = await this.prisma.products.findMany({
          where: { status: 'active', id: { not: cart[0].id }, substances: { some: { substance_id: { in: [...partners] } } } },
          select: { id: true, inventory: { select: { actual_qty: true, reserved_qty: true } } },
          orderBy: { sku: 'asc' },
          take: 50,
        });
        const inStock = found.filter((p) => availableQty(p.inventory) > 0).slice(0, CANDIDATES_MAX);
        const offered = await this.products(inStock.map((p) => p.id));
        candidates = offered.map(toAi);
        for (const p of offered) refs.set(p.sku, p.id);
        const offeredSubs = new Set(offered.flatMap((p) => [...withParents(own(p), k.parentOf)]));
        rules = synergy.filter((r) => offeredSubs.has(r.substance_a_id) || offeredSubs.has(r.substance_b_id));
      }
    }
    const overlaps = overlapsForProducts(withSubs, k.parentOf);
    floor = applyOverlapFloor(floor, overlaps);
    const skuOf = new Map(cart.map((p) => [p.id, p.sku]));
    return {
      data: {
        lang,
        cart: cart.map(toAi),
        rules: rules.map(toRule),
        drugRules: drugRules.map(toRule),
        overlaps: overlaps.map((o) => ({ substance: name(o.substance), refs: o.products.map((id) => skuOf.get(id)!) })),
        candidates,
      },
      floor,
      refs,
    };
  }

  /** The answer as the cart shows it; overlaps and medicine lines are computed now, suggestions out of stock are dropped. */
  private async view(a: ai_compat_answers, items: Item[], lang: Lang): Promise<AiView> {
    const k = await this.knowledge();
    const rows = await this.products(items.map((i) => i.product_id));
    const withSubs = rows.map((p) => ({ id: p.id, substances: withParents(p.substances.map((x) => x.substance_id).filter((id) => k.names.has(id)), k.parentOf) }));
    const all = new Set(withSubs.flatMap((p) => [...p.substances]));
    const nameOf = (id: string) => (lang === 'uz' ? k.names.get(id)?.uz : k.names.get(id)?.ru) ?? id;
    const overlaps = overlapsForProducts(withSubs, k.parentOf).map((o) => nameOf(o.substance));
    const isDrug = (id: string) => k.names.get(id)?.kind === 'drug_group';
    const drugs = k.rules
      .filter((r) => (all.has(r.substance_a_id) && isDrug(r.substance_b_id)) || (all.has(r.substance_b_id) && isDrug(r.substance_a_id)))
      .map((r) => (lang === 'uz' ? r.text_uz : r.text_ru));
    const itemName = new Map(items.map((i) => [i.product_id, lang === 'uz' ? i.name_uz || i.name_ru : i.name_ru]));
    const timing = (Array.isArray(a.timing) ? (a.timing as { product_id: string; when: string }[]) : []).map((t) => ({ product_id: t.product_id, name: itemName.get(t.product_id) ?? '', when: t.when }));
    const sugg = a.suggested_ids.length
      ? await this.prisma.products.findMany({
          where: { id: { in: a.suggested_ids }, status: 'active' },
          select: { id: true, name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true, inventory: { select: { actual_qty: true, reserved_qty: true } } },
        })
      : [];
    return {
      answer_id: a.id,
      verdict: applyOverlapFloor(a.verdict as Verdict, overlaps.map((s) => ({ substance: s, products: [] }))),
      text: a.text,
      timing,
      suggestions: sugg.filter((p) => availableQty(p.inventory) > 0).map((p) => ({ product_id: p.id, name: productTitle(p, lang) })),
      overlaps,
      overlap_text: overlaps.length ? OVERLAP_TEXT[lang] : null,
      drugs: [...new Set(drugs)],
    };
  }

  // ---------------- admin ----------------

  async saveSettings(me: staff_users, value: unknown) {
    const next = mergeAiSettings({ ...(await this.settings()), ...(value && typeof value === 'object' ? value : {}) });
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.settings.findUnique({ where: { key: SETTING_AI } });
      const json = next as unknown as Prisma.InputJsonObject;
      await tx.settings.upsert({ where: { key: SETTING_AI }, create: { key: SETTING_AI, value: json }, update: { value: json } });
      await this.audit.log({ staffId: me.id, action: 'settings.vitalo_ai_updated', entityType: 'settings', before: before?.value, after: { key: SETTING_AI, value: json } }, tx);
    });
    return this.adminSettings();
  }

  /** «Настройки → VITALO AI»: the settings, whether the key is set (never the key itself) and the spend. */
  async adminSettings(now = new Date()) {
    const sum = async (from: Date) => {
      const agg = await this.prisma.ai_requests.aggregate({ _sum: { cost_usd: true }, _count: true, where: { created_at: { gte: from } } });
      return { requests: agg._count, cost_usd: Number(agg._sum.cost_usd ?? 0) };
    };
    return {
      settings: await this.settings(),
      defaults: DEFAULT_AI_SETTINGS,
      key_set: this.model.ready(),
      today: await sum(tashkentDayStart(now)),
      month: await sum(tashkentMonthStart(now)),
    };
  }
}

// ---------------- DTOs and controllers ----------------

export class AiSettingsDto {
  @ApiProperty({ example: { enabled: true, model: 'claude-haiku-5-5', monthly_budget_usd: 20, cart_daily_limit: 1, chat_daily_limit: 20 } }) @IsObject() settings!: Record<string, unknown>;
}

@ApiTags('compat')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('compat/ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get()
  state(@CurrentAuth() auth: AuthContext) {
    return this.ai.state(auth.user.id);
  }

  @Post('consent')
  @HttpCode(200)
  consent(@CurrentAuth() auth: AuthContext) {
    return this.ai.consent(auth.user.id);
  }

  @Post('check')
  @HttpCode(200)
  check(@CurrentAuth() auth: AuthContext) {
    return this.ai.check(auth.user.id);
  }
}

@ApiTags('staff: settings')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/ai')
export class AdminAiController {
  constructor(private readonly ai: AiService) {}

  @Get('settings')
  @RequirePermission('settings.manage')
  settings() {
    return this.ai.adminSettings();
  }

  @Put('settings')
  @RequirePermission('settings.manage')
  save(@CurrentStaff() me: StaffContext, @Body() dto: AiSettingsDto) {
    return this.ai.saveSettings(me.staff, dto.settings);
  }
}

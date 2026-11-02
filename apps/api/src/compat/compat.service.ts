import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ApiBearerAuth, ApiExcludeController, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, type compat_requests, type staff_users } from '@prisma/client';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { AnalyticsService } from '../analytics/analytics.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { BotSecretGuard } from '../bot-internal/bot-internal.module';
import { renderNotification, type TemplatePayload } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
import { SystemErrorsService } from '../notifications/system-errors';
import { TELEGRAM_SENDER, type TelegramSender } from '../notifications/telegram-sender';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { can } from '../staff/permissions';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { productTitle } from '../waitlist/waitlist';
import {
  ANSWER_MAX,
  answerIn,
  COMMENT_DAYS,
  COMMENT_MAX,
  DAILY_LIMIT,
  SETTING_COMPAT_TEMPLATES,
  VERDICT_CODES,
  VERDICT_LABELS,
  VERDICTS,
  mergeTemplates,
  setKeyOf,
  tashkentDayStart,
  type CompatTemplates,
  type Lang,
  type Verdict,
} from './compat';

export type Item = { product_id: string; sku: string; name_ru: string; name_uz: string };

export const langOf = (l: string | null | undefined): Lang => (l === 'uz' ? 'uz' : 'ru');
/** specialist | instant (a saved answer) | ai | ai_cache (VITALO AI, 3.8) | ai_fallback (AI could not answer — the specialist does) */
export type CompatSource = 'specialist' | 'instant' | 'ai' | 'ai_cache' | 'ai_fallback';
const itemsOf = (json: Prisma.JsonValue): Item[] => (Array.isArray(json) ? (json as unknown as Item[]) : []);
const nameIn = (i: Item, lang: Lang) => (lang === 'uz' ? i.name_uz || i.name_ru : i.name_ru);

/** Admin, or any active employee marked «специалист» (D-40: they may read the customer's comment). */
export function canAnswer(staff: Pick<staff_users, 'role' | 'status' | 'is_specialist'>): boolean {
  return staff.status === 'active' && can(staff.role, 'compat.answer', staff.is_specialist);
}

export type AnswerResult =
  | { result: 'answered'; verdict: Verdict; by: string }
  | { result: 'already'; verdict: Verdict | null; by: string | null }
  | { result: 'closed' };

/**
 * 3.4: «Проверить совместимость у специалиста» (D-11, D-40). The customer sends the cart (2+ different products) with an
 * optional comment; admins and specialists get it in the bot with quick answers and in «Совместимость»; the answer comes
 * back to the bot, the Mini App centre and the cart. An answer marked «Можно использовать повторно» is given at once to
 * the same set of products in the same language — only when the customer wrote no comment.
 */
@Injectable()
export class CompatService {
  private readonly logger = new Logger(CompatService.name);
  private purging = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
    private readonly errors: SystemErrorsService,
    @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender,
  ) {}

  // ---------------- customer ----------------

  async cartItems(userId: string): Promise<Item[]> {
    const cart = await this.prisma.carts.findFirst({
      where: { user_id: userId, status: 'active' },
      include: { items: { include: { product: { select: { id: true, sku: true, name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true } } }, orderBy: { created_at: 'asc' } } },
    });
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const l of cart?.items ?? []) {
      if (seen.has(l.product_id)) continue;
      seen.add(l.product_id);
      out.push({ product_id: l.product_id, sku: l.product.sku, name_ru: productTitle(l.product, 'ru'), name_uz: productTitle(l.product, 'uz') });
    }
    return out;
  }

  private sentToday(userId: string, now: Date) {
    return this.prisma.compat_requests.count({ where: { user_id: userId, source: 'specialist', created_at: { gte: tashkentDayStart(now) } } });
  }

  private requestView(r: compat_requests, setKey: string, lang: Lang, templates: CompatTemplates) {
    return {
      id: r.id,
      status: r.status as 'pending' | 'answered',
      source: r.source as CompatSource,
      verdict: (r.verdict as Verdict | null) ?? null,
      text: answerIn(r.answer_text, r.verdict as Verdict | null, langOf(r.lang), lang, templates),
      created_at: r.created_at,
      answered_at: r.answered_at,
      /** the cart is not the one the answer was about any more — «Состав корзины изменился — проверьте снова» */
      changed: r.set_key !== setKey,
      products: itemsOf(r.items).map((i) => nameIn(i, lang)),
    };
  }

  /** What the cart shows: whether the button is offered, the latest request (pending or answered) and the limit left. */
  async state(userId: string, now = new Date()) {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { language: true } });
    const lang = langOf(user.language);
    const items = await this.cartItems(userId);
    const setKey = setKeyOf(items.map((i) => i.product_id));
    const latest = await this.prisma.compat_requests.findFirst({ where: { user_id: userId, status: { in: ['pending', 'answered'] } }, orderBy: { created_at: 'desc' } });
    return {
      eligible: items.length >= 2,
      products: items.map((i) => nameIn(i, lang)),
      left_today: Math.max(0, DAILY_LIMIT - (await this.sentToday(userId, now))),
      request: latest ? this.requestView(latest, setKey, lang, await this.templates()) : null,
    };
  }

  async create(userId: string, rawComment: string | undefined, now = new Date()) {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId } });
    const lang = langOf(user.language);
    const comment = rawComment?.trim() || null;
    const items = await this.cartItems(userId);
    if (items.length < 2) throw new BadRequestException({ code: 'NOT_ENOUGH_ITEMS', message: 'Two or more different products are needed' });
    const setKey = setKeyOf(items.map((i) => i.product_id));

    // one waiting request per cart composition
    const pending = await this.prisma.compat_requests.findFirst({ where: { user_id: userId, status: 'pending', set_key: setKey } });
    if (pending) throw new ConflictException({ code: 'ALREADY_PENDING', message: 'The request for this cart is already with the specialist' });

    // a saved answer for the same set and language — only without a comment (a comment is for a person to read)
    if (!comment && (await this.answerFromSaved(userId, items, lang, now))) return { result: 'instant' as const, ...(await this.state(userId, now)) };

    if ((await this.sentToday(userId, now)) >= DAILY_LIMIT) {
      throw new HttpException({ code: 'DAILY_LIMIT', message: `No more than ${DAILY_LIMIT} requests a day` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.queue(userId, items, lang, comment, 'specialist');
    await this.analytics.track(userId, 'compat_request', { products: items.length, has_comment: !!comment, lang });
    return { result: 'sent' as const, ...(await this.state(userId, now)) };
  }

  /** A saved specialist answer for this set and language, given at once (source «instant»). False — there is none. */
  async answerFromSaved(userId: string, items: Item[], lang: Lang, now = new Date()): Promise<boolean> {
    const setKey = setKeyOf(items.map((i) => i.product_id));
    const saved = await this.prisma.compat_answers.findUnique({ where: { set_key_lang: { set_key: setKey, lang } } });
    if (!saved?.enabled) return false;
    await this.prisma.compat_requests.create({
      data: { user_id: userId, product_ids: setKey.split(','), set_key: setKey, items: items as unknown as Prisma.InputJsonArray, lang, status: 'answered', source: 'instant', verdict: saved.verdict, answer_text: saved.text, answered_at: now, saved_answer_id: saved.id },
    });
    await this.analytics.track(userId, 'compat_instant_answer', { products: items.length, verdict: saved.verdict, lang });
    return true;
  }

  /**
   * A waiting request for the specialists: older waiting ones of this customer are closed, admins and specialists get
   * it in the bot. source «ai_fallback» — VITALO AI could not answer (3.8); it does not count in the 5 a day.
   */
  async queue(userId: string, items: Item[], lang: Lang, comment: string | null, source: 'specialist' | 'ai_fallback') {
    const setKey = setKeyOf(items.map((i) => i.product_id));
    const closed = await this.prisma.$transaction(async (tx) => {
      // the cart changed while an older request waited: it is closed, the specialist answers the new one
      const old = await tx.compat_requests.findMany({ where: { user_id: userId, status: 'pending' }, select: { id: true } });
      if (old.length) await tx.compat_requests.updateMany({ where: { id: { in: old.map((o) => o.id) }, status: 'pending' }, data: { status: 'closed' } });
      const req = await tx.compat_requests.create({ data: { user_id: userId, product_ids: setKey.split(','), set_key: setKey, items: items as unknown as Prisma.InputJsonArray, lang, comment, source } });
      const staff = await tx.staff_users.findMany({ where: { status: 'active', OR: [{ role: 'admin' }, { is_specialist: true }] } });
      if (staff.length) {
        const payload: TemplatePayload = {
          order_number: '',
          lang: 'ru',
          compat_id: req.id,
          client_lang: lang,
          items: items.map((i) => `• ${i.name_ru} (${i.sku})`).join('\n'),
          comment,
          admin_path: '/compat',
        };
        await tx.notifications.createMany({
          data: staff.map((s) => ({ staff_user_id: s.id, chat_id: s.telegram_user_id, kind: 'service', template: 'staff.compat_request', payload: payload as unknown as Prisma.InputJsonObject })),
        });
      }
      return old.map((o) => o.id);
    });
    for (const id of closed) await this.settleStaffMessages(id, 'Клиент изменил корзину — запрос закрыт, пришёл новый.');
  }

  // ---------------- specialist ----------------

  async templates(): Promise<CompatTemplates> {
    const row = await this.prisma.settings.findUnique({ where: { key: SETTING_COMPAT_TEMPLATES } });
    return mergeTemplates(row?.value);
  }

  /**
   * The one way an answer is given (bot buttons, own text in the bot, admin panel). Only a waiting request is answered;
   * the first answer wins, a second one gets «уже ответил …». The customer gets the bot message + the centre entry.
   */
  async answer(staff: staff_users, id: string, input: { verdict: Verdict; text?: string | null; reuse?: boolean }, via: 'bot' | 'admin', now = new Date()): Promise<AnswerResult> {
    if (!canAnswer(staff)) throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: 'Only an admin or a specialist can answer' });
    if (!VERDICTS.includes(input.verdict)) throw new BadRequestException({ code: 'BAD_VERDICT', message: 'Unknown verdict' });
    const req = await this.prisma.compat_requests.findUnique({ where: { id }, include: { answerer: true, user: true } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status === 'closed') return { result: 'closed' };
    if (req.status === 'answered') return { result: 'already', verdict: req.verdict as Verdict, by: req.answerer?.name ?? null };

    // the customer may have switched RU/UZ since the request: a template answer goes in the language they use now;
    // an own text stays in the language it was written for (the request's)
    const lang = langOf(req.user.language);
    const own = input.text?.trim();
    const templates = await this.templates();
    const text = (own || templates[input.verdict][lang]).slice(0, ANSWER_MAX);
    const textLang = own ? langOf(req.lang) : lang;
    const both = own ? {} : { answer_ru: templates[input.verdict].ru, answer_uz: templates[input.verdict].uz };
    const done = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.compat_requests.updateMany({ where: { id, status: 'pending' }, data: { status: 'answered', lang: textLang, verdict: input.verdict, answer_text: text, answered_by: staff.id, answered_at: now } });
      if (!claimed.count) return false;
      if (input.reuse) {
        const saved = await this.saveAnswer(tx, staff.id, { ...req, lang: textLang, verdict: input.verdict, answer_text: text });
        await tx.compat_requests.update({ where: { id }, data: { saved_answer_id: saved.id } });
      }
      await this.notifications.toCustomer(tx, {
        userId: req.user_id,
        chatId: req.user.telegram_user_id,
        category: 'compat',
        template: 'compat.answered',
        payload: { order_number: '', lang, compat_id: id, verdict: input.verdict, answer: text, ...both, open_path: '/cart', open_button: 'cart' },
        dedupKey: `compat:${id}:answered`,
      });
      // the customer's comment is never copied into the audit log (D-40)
      await this.audit.log({ staffId: staff.id, action: 'compat.answered', entityType: 'compat_request', entityId: id, after: { verdict: input.verdict, via, reuse: !!input.reuse } }, tx);
      return true;
    });
    if (!done) {
      const again = await this.prisma.compat_requests.findUniqueOrThrow({ where: { id }, include: { answerer: true } });
      return again.status === 'closed' ? { result: 'closed' } : { result: 'already', verdict: again.verdict as Verdict, by: again.answerer?.name ?? null };
    }
    await this.analytics.track(req.user_id, 'compat_answered', { verdict: input.verdict, via, reuse: !!input.reuse, minutes: Math.round((now.getTime() - req.created_at.getTime()) / 60_000) });
    await this.settleStaffMessages(id, `Ответ дан — ${staff.name}: ${VERDICT_LABELS[input.verdict].ru}`);
    return { result: 'answered', verdict: input.verdict, by: staff.name };
  }

  /** Saved combination: one per set of products and language; saving again replaces the text and switches it on. */
  private saveAnswer(db: Prisma.TransactionClient | PrismaService, staffId: string, r: Pick<compat_requests, 'id' | 'set_key' | 'product_ids' | 'items' | 'lang' | 'verdict' | 'answer_text'>) {
    const data = { verdict: r.verdict!, text: r.answer_text!, enabled: true, source_request_id: r.id, created_by: staffId };
    return db.compat_answers.upsert({
      where: { set_key_lang: { set_key: r.set_key, lang: r.lang } },
      create: { set_key: r.set_key, product_ids: r.product_ids, items: r.items as Prisma.InputJsonValue, lang: r.lang, ...data },
      update: data,
    });
  }

  /** The bot messages of a request lose their buttons and get the outcome (best effort: an old message may not change). */
  private async settleStaffMessages(id: string, line: string) {
    if (!this.sender.editMessage) return;
    const rows = await this.prisma.notifications.findMany({ where: { template: 'staff.compat_request', status: 'sent', payload: { path: ['compat_id'], equals: id } } });
    for (const n of rows) {
      const p = (n.payload ?? {}) as unknown as TemplatePayload;
      if (!p.tg_message_id) continue;
      try {
        await this.sender.editMessage(n.chat_id, p.tg_message_id, `${renderNotification(n.template, p)}\n\n${line}`);
      } catch {
        // too old or already changed: the request in the admin panel shows the outcome anyway
      }
    }
  }

  // ---------------- admin panel ----------------

  async list(me: staff_users, status: 'pending' | 'answered') {
    const showComment = canAnswer(me);
    const rows = await this.prisma.compat_requests.findMany({
      where: status === 'pending' ? { status: 'pending' } : { status: 'answered' },
      orderBy: { created_at: status === 'pending' ? 'asc' : 'desc' },
      take: 200,
      include: { user: { select: { first_name: true, last_name: true, username: true } }, answerer: { select: { name: true } }, saved_answer: { select: { id: true, enabled: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      status: r.status,
      source: r.source,
      lang: r.lang,
      customer: [r.user.first_name, r.user.last_name].filter(Boolean).join(' ') + (r.user.username ? ` (@${r.user.username})` : ''),
      products: itemsOf(r.items).map((i) => ({ product_id: i.product_id, sku: i.sku, name: i.name_ru })),
      has_comment: !!r.comment,
      comment: showComment ? r.comment : null,
      comment_hidden: !showComment && !!r.comment,
      comment_purged: !!r.comment_purged_at,
      verdict: r.verdict,
      answer_text: r.answer_text,
      answered_by: r.answerer?.name ?? null,
      answered_at: r.answered_at,
      saved: !!r.saved_answer?.enabled,
    }));
  }

  /** «Можно использовать повторно» for an already answered request. */
  async saveFromRequest(me: staff_users, id: string) {
    const r = await this.prisma.compat_requests.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Request not found');
    if (r.status !== 'answered' || !r.verdict || !r.answer_text) throw new ConflictException({ code: 'NOT_ANSWERED', message: 'Only an answered request can be saved' });
    await this.prisma.$transaction(async (tx) => {
      const saved = await this.saveAnswer(tx, me.id, r);
      await tx.compat_requests.update({ where: { id }, data: { saved_answer_id: saved.id } });
      await this.audit.log({ staffId: me.id, action: 'compat.saved', entityType: 'compat_answer', entityId: saved.id, after: { verdict: saved.verdict, lang: saved.lang } }, tx);
    });
    return this.answers();
  }

  async answers() {
    const rows = await this.prisma.compat_answers.findMany({ orderBy: [{ enabled: 'desc' }, { updated_at: 'desc' }], include: { author: { select: { name: true } }, _count: { select: { requests: true } } } });
    return rows.map((a) => ({
      id: a.id,
      lang: a.lang,
      verdict: a.verdict,
      text: a.text,
      enabled: a.enabled,
      products: itemsOf(a.items).map((i) => ({ product_id: i.product_id, sku: i.sku, name: i.name_ru })),
      author: a.author?.name ?? null,
      used: a._count.requests,
      updated_at: a.updated_at,
    }));
  }

  async updateAnswer(me: staff_users, id: string, dto: { verdict?: Verdict; text?: string; enabled?: boolean }) {
    const before = await this.prisma.compat_answers.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Saved answer not found');
    const text = dto.text?.trim();
    if (dto.text !== undefined && !text) throw new BadRequestException({ code: 'EMPTY_TEXT', message: 'The answer cannot be empty' });
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.compat_answers.update({ where: { id }, data: { ...(dto.verdict && { verdict: dto.verdict }), ...(text && { text }), ...(dto.enabled !== undefined && { enabled: dto.enabled }) } });
      await this.audit.log({ staffId: me.id, action: 'compat.saved_updated', entityType: 'compat_answer', entityId: id, before, after }, tx);
    });
    return this.answers();
  }

  async setTemplates(me: staff_users, value: unknown) {
    for (const v of VERDICTS) {
      for (const l of ['ru', 'uz'] as const) {
        const text = (value as Record<string, Record<string, unknown>> | null)?.[v]?.[l];
        if (typeof text !== 'string' || !text.trim() || text.length > ANSWER_MAX) {
          throw new BadRequestException({ code: 'BAD_TEMPLATE', message: `Template ${v}.${l} must be a text up to ${ANSWER_MAX} characters` });
        }
      }
    }
    const next = mergeTemplates(value);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.settings.findUnique({ where: { key: SETTING_COMPAT_TEMPLATES } });
      const json = next as unknown as Prisma.InputJsonObject;
      await tx.settings.upsert({ where: { key: SETTING_COMPAT_TEMPLATES }, create: { key: SETTING_COMPAT_TEMPLATES, value: json }, update: { value: json } });
      await this.audit.log({ staffId: me.id, action: 'settings.compat_templates_updated', entityType: 'settings', before: before?.value, after: { key: SETTING_COMPAT_TEMPLATES, value: json } }, tx);
    });
    return next;
  }

  // ---------------- privacy (D-40) ----------------

  @Interval('compat-purge', 3600_000)
  async tick() {
    if (this.purging) return;
    this.purging = true;
    try {
      const n = await this.purgeComments();
      if (n) this.logger.log(`Compatibility: ${n} comment(s) older than ${COMMENT_DAYS} days cleared`);
    } catch (e) {
      this.logger.error('Compatibility purge failed', e as Error);
      await this.errors.record({ level: 'error', service: 'compat', message: `Compatibility purge failed: ${(e as Error).message}`, context: { job: 'compat-purge' } });
    } finally {
      this.purging = false;
    }
  }

  /**
   * The customer's comment may hold health data: after 90 days its text is removed from the request and from the
   * staff messages queued for it. The request itself and the answer stay. Returns how many requests were cleared.
   */
  async purgeComments(now = new Date()): Promise<number> {
    const cut = new Date(now.getTime() - COMMENT_DAYS * 24 * 3600_000);
    const res = await this.prisma.compat_requests.updateMany({ where: { comment: { not: null }, created_at: { lt: cut } }, data: { comment: null, comment_purged_at: now } });
    await this.prisma.$executeRaw`
      UPDATE notifications SET payload = jsonb_set(payload, '{comment}', 'null'::jsonb)
      WHERE template = 'staff.compat_request' AND created_at < ${cut} AND payload->>'comment' IS NOT NULL`;
    return res.count;
  }

  // ---------------- bot ----------------

  async staffByTelegram(rawTelegramId: unknown): Promise<staff_users> {
    const s = String(rawTelegramId ?? '');
    if (!/^\d{1,20}$/.test(s)) throw new BadRequestException('telegram_id must be digits');
    const staff = await this.prisma.staff_users.findUnique({ where: { telegram_user_id: BigInt(s) } });
    if (!staff || !canAnswer(staff)) throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: 'Only an admin or a specialist can answer' });
    return staff;
  }
}

// ---------------- DTOs ----------------

export class CompatRequestDto {
  @ApiPropertyOptional({ description: 'Комментарий клиента (необязательно)' }) @IsOptional() @IsString() @MaxLength(COMMENT_MAX) comment?: string;
}

export class CompatAnswerDto {
  @ApiProperty({ enum: VERDICTS }) @IsIn(VERDICTS) verdict!: Verdict;
  @ApiPropertyOptional({ description: 'Пусто — текст шаблона на языке клиента' }) @IsOptional() @IsString() @MaxLength(ANSWER_MAX) text?: string;
  @ApiPropertyOptional({ description: 'Можно использовать повторно' }) @IsOptional() @IsBoolean() reuse?: boolean;
}

export class CompatSavedPatch {
  @ApiPropertyOptional({ enum: VERDICTS }) @IsOptional() @IsIn(VERDICTS) verdict?: Verdict;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(ANSWER_MAX) text?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
}

export class CompatTemplatesDto {
  @ApiProperty({ example: { compatible: { ru: '…', uz: '…' }, spread: { ru: '…', uz: '…' }, consult: { ru: '…', uz: '…' } } }) @IsObject() templates!: Record<string, unknown>;
}

class CompatListQuery {
  @ApiPropertyOptional({ enum: ['pending', 'answered'] }) @IsOptional() @IsIn(['pending', 'answered']) status?: 'pending' | 'answered';
}

// ---------------- controllers ----------------

@ApiTags('compat')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('compat')
export class CompatController {
  constructor(private readonly compat: CompatService) {}

  /** The cart's compatibility block: the button (2+ different products), the latest request, requests left today. */
  @Get()
  state(@CurrentAuth() auth: AuthContext) {
    return this.compat.state(auth.user.id);
  }

  /** «Отправить»: 400 NOT_ENOUGH_ITEMS, 409 ALREADY_PENDING, 429 DAILY_LIMIT; result = sent | instant. */
  @Post()
  @HttpCode(200)
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CompatRequestDto) {
    return this.compat.create(auth.user.id, dto.comment);
  }
}

@ApiTags('staff: compat')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/compat')
export class AdminCompatController {
  constructor(private readonly compat: CompatService) {}

  @Get('requests')
  @RequirePermission('compat.view')
  list(@CurrentStaff() me: StaffContext, @Query() q: CompatListQuery) {
    return this.compat.list(me.staff, q.status ?? 'pending');
  }

  @Post('requests/:id/answer')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  answer(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CompatAnswerDto) {
    return this.compat.answer(me.staff, id, dto, 'admin');
  }

  @Post('requests/:id/save')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  save(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.compat.saveFromRequest(me.staff, id);
  }

  @Get('answers')
  @RequirePermission('compat.view')
  answers() {
    return this.compat.answers();
  }

  @Patch('answers/:id')
  @RequirePermission('compat.answer')
  updateAnswer(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CompatSavedPatch) {
    return this.compat.updateAnswer(me.staff, id, dto);
  }

  @Get('templates')
  @RequirePermission('compat.view')
  templates() {
    return this.compat.templates();
  }

  @Put('templates')
  @RequirePermission('compat.answer')
  setTemplates(@CurrentStaff() me: StaffContext, @Body() dto: CompatTemplatesDto) {
    return this.compat.setTemplates(me.staff, dto.templates);
  }
}

const CODE_TO_VERDICT = Object.fromEntries(VERDICTS.map((v) => [VERDICT_CODES[v], v])) as Record<string, Verdict>;

/** Called by the bot only (X-Bot-Secret): the specialist's buttons and own text. */
@ApiExcludeController()
@UseGuards(BotSecretGuard)
@Controller('internal/bot/compat')
export class BotCompatController {
  constructor(private readonly compat: CompatService) {}

  @Post(':id/answer')
  @HttpCode(200)
  async answer(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: { telegram_id?: unknown; verdict?: string; text?: string }) {
    const staff = await this.compat.staffByTelegram(body.telegram_id);
    const verdict = CODE_TO_VERDICT[body.verdict ?? ''] ?? (VERDICTS.includes(body.verdict as Verdict) ? (body.verdict as Verdict) : null);
    if (!verdict) throw new BadRequestException({ code: 'BAD_VERDICT', message: 'Unknown verdict' });
    const text = typeof body.text === 'string' ? body.text.slice(0, ANSWER_MAX) : undefined;
    return this.compat.answer(staff, id, { verdict, text }, 'bot');
  }
}

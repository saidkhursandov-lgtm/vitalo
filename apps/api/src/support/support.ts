import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, type staff_users } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { SUPPORT_TOPIC_CODES, supportNo, type Lang, type SupportTopic } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { productTitle } from '../waitlist/waitlist';

/** A message is at most this long (a question or a reply). */
export const SUPPORT_TEXT_MAX = 2000;
/** A customer may start at most this many questions a day (spam guard). */
export const SUPPORT_DAILY_LIMIT = 10;

/** D-40: a medical question may hold health data — only admins and specialists see it. */
export const seesMedical = (s: Pick<staff_users, 'role' | 'is_specialist'>) => s.role === 'admin' || s.is_specialist;

const langOf = (l: string | null | undefined): Lang => (l === 'uz' ? 'uz' : 'ru');
const customerName = (u: { first_name: string; last_name: string | null; username: string | null }) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '—';
const THREAD_INCLUDE = { product: true, order: true, messages: { orderBy: { created_at: 'asc' }, include: { staff: true } } } satisfies Prisma.support_threadsInclude;
type ThreadRow = Prisma.support_threadsGetPayload<{ include: typeof THREAD_INCLUDE }>;

/**
 * 6б-Б (D-63): the support centre — numbered requests, the order they are about, closing with a rating, the shop
 * writing first from the order card.
 * 6а-Д (D-62): «Спросить специалиста» inside the Mini App. The customer picks a topic (chips), writes the question;
 * from a product card the product is attached by itself. The shop answers in Админка → Обращения; the answer comes to
 * «Уведомления → Личные» and as a bot message, and the customer can reply inside the Mini App.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private view(t: ThreadRow, lang: Lang) {
    return {
      id: t.id,
      number: supportNo(t.number),
      topic: t.topic as SupportTopic,
      status: t.status,
      unread: t.customer_unread,
      started_by: t.started_by,
      rating: t.rating,
      closed_at: t.closed_at,
      product: t.product ? { id: t.product.id, name: productTitle(t.product, lang), image_url: null as string | null } : null,
      order: t.order ? { id: t.order.id, number: t.order.order_number } : null,
      last_message_at: t.last_message_at,
      created_at: t.created_at,
      messages: t.messages.map((m) => ({ id: m.id, author: m.author as 'customer' | 'staff', text: m.text, created_at: m.created_at })),
    };
  }

  /** Who hears about a customer's message: medical — admins and specialists; other topics — admins and managers. */
  private async tellStaff(db: Prisma.TransactionClient, thread: { id: string; topic: string; number: number }, text: string, product: string | null, orderNumber?: string | null) {
    const medical = thread.topic === 'medical';
    const staff = await db.staff_users.findMany({
      where: { status: 'active', OR: medical ? [{ role: 'admin' }, { is_specialist: true }] : [{ role: { in: ['admin', 'manager'] } }] },
    });
    if (!staff.length) return;
    await db.notifications.createMany({
      data: staff.map((s) => ({
        staff_user_id: s.id,
        chat_id: s.telegram_user_id,
        kind: 'service',
        template: 'staff.support_new',
        payload: { lang: 'ru', topic: thread.topic, thread_no: supportNo(thread.number), order_number: orderNumber ?? undefined, question: text.slice(0, 600), product: product ?? undefined, admin_path: `/support/${thread.id}` } as Prisma.InputJsonObject,
      })),
    });
  }

  async create(userId: string, dto: { topic: SupportTopic; text: string; product_id?: string; order_id?: string }) {
    const text = dto.text.trim();
    const since = new Date(Date.now() - 24 * 3600_000);
    const today = await this.prisma.support_threads.count({ where: { user_id: userId, created_at: { gte: since } } });
    if (today >= SUPPORT_DAILY_LIMIT) throw new ForbiddenException({ code: 'DAILY_LIMIT', message: 'Too many questions today' });
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId } });
    const product = dto.product_id ? await this.prisma.products.findUnique({ where: { id: dto.product_id } }) : null;
    // 6б-Б: only the customer's own order can be attached
    const order = dto.order_id ? await this.prisma.orders.findFirst({ where: { id: dto.order_id, user_id: userId } }) : null;
    if (dto.order_id && !order) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found' });
    const id = await this.prisma.$transaction(async (tx) => {
      const t = await tx.support_threads.create({
        data: { user_id: userId, topic: dto.topic, product_id: product?.id ?? null, order_id: order?.id ?? null, lang: langOf(user.language), messages: { create: { author: 'customer', text } } },
      });
      await this.tellStaff(tx, t, text, product ? `${product.sku} ${productTitle(product, 'ru')}` : null, order?.order_number);
      return t.id;
    });
    return this.one(userId, id);
  }

  async list(userId: string) {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId } });
    const rows = await this.prisma.support_threads.findMany({
      where: { user_id: userId },
      orderBy: { last_message_at: 'desc' },
      take: 50,
      include: THREAD_INCLUDE,
    });
    return rows.map((t) => this.view(t, langOf(user.language)));
  }

  /** The conversation; opening it marks the shop's replies read (and their «Личные» cards). */
  async one(userId: string, id: string) {
    const t = await this.prisma.support_threads.findFirst({ where: { id, user_id: userId }, include: { ...THREAD_INCLUDE, user: true } });
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Question not found' });
    if (t.customer_unread) {
      await this.prisma.support_threads.update({ where: { id }, data: { customer_unread: 0 } });
      await this.prisma.notifications.updateMany({ where: { user_id: userId, template: { in: ['support.reply', 'support.closed'] }, read_at: null, payload: { path: ['thread_id'], equals: id } }, data: { read_at: new Date() } });
    }
    return { ...this.view(t, langOf(t.user.language)), unread: 0 };
  }

  async reply(userId: string, id: string, raw: string) {
    const text = raw.trim();
    const t = await this.prisma.support_threads.findFirst({ where: { id, user_id: userId }, include: { product: true, order: true } });
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Question not found' });
    // 6б-Б: a closed request takes no more messages — the customer starts a new one
    if (t.status === 'closed') throw new ConflictException({ code: 'THREAD_CLOSED', message: 'The request is closed' });
    await this.prisma.$transaction(async (tx) => {
      await tx.support_messages.create({ data: { thread_id: id, author: 'customer', text } });
      await tx.support_threads.update({ where: { id }, data: { status: 'open', last_message_at: new Date() } });
      await this.tellStaff(tx, t, text, t.product ? `${t.product.sku} ${productTitle(t.product, 'ru')}` : null, t.order?.order_number);
    });
    return this.one(userId, id);
  }

  /** 6б-Б: 1–5 stars after the shop closed the request (may be changed). */
  async rate(userId: string, id: string, rating: number) {
    const t = await this.prisma.support_threads.findFirst({ where: { id, user_id: userId } });
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Question not found' });
    if (t.status !== 'closed') throw new ConflictException({ code: 'THREAD_NOT_CLOSED', message: 'Only a closed request can be rated' });
    await this.prisma.support_threads.update({ where: { id }, data: { rating, rated_at: new Date() } });
    await this.prisma.analytics_events.create({ data: { user_id: userId, event: 'support_rated', props: { thread_id: id, rating, topic: t.topic } } });
    return this.one(userId, id);
  }

  // ---------------- staff ----------------

  async staffList(staff: staff_users, status: 'open' | 'answered' | 'closed') {
    const rows = await this.prisma.support_threads.findMany({
      where: { status, ...(seesMedical(staff) ? {} : { topic: { not: 'medical' } }) },
      orderBy: { last_message_at: status === 'open' ? 'asc' : 'desc' },
      take: 100,
      include: { user: true, product: true, order: true, messages: { orderBy: { created_at: 'desc' }, take: 1 } },
    });
    const counts = await this.prisma.support_threads.groupBy({ by: ['status'], _count: true, where: seesMedical(staff) ? {} : { topic: { not: 'medical' } } });
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      items: rows.map((t) => ({
        id: t.id,
        number: supportNo(t.number),
        topic: t.topic,
        status: t.status,
        lang: t.lang,
        rating: t.rating,
        started_by: t.started_by,
        customer: customerName(t.user),
        product: t.product ? `${t.product.sku} ${productTitle(t.product, 'ru')}` : null,
        order_number: t.order?.order_number ?? null,
        last_text: t.messages[0]?.text.slice(0, 160) ?? '',
        last_author: t.messages[0]?.author ?? 'customer',
        last_message_at: t.last_message_at,
      })),
    };
  }

  private async staffThread(staff: staff_users, id: string) {
    const t = await this.prisma.support_threads.findUnique({ where: { id }, include: { ...THREAD_INCLUDE, user: true, closer: true } });
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Question not found' });
    if (t.topic === 'medical' && !seesMedical(staff)) throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: 'Medical questions: admins and specialists only' });
    return t;
  }

  async staffOne(staff: staff_users, id: string) {
    const t = await this.staffThread(staff, id);
    return {
      id: t.id,
      number: supportNo(t.number),
      topic: t.topic,
      status: t.status,
      lang: t.lang,
      rating: t.rating,
      started_by: t.started_by,
      closed_at: t.closed_at,
      closed_by: t.closer?.name ?? null,
      customer: { name: customerName(t.user), phone: t.user.phone, username: t.user.username },
      product: t.product ? { id: t.product.id, sku: t.product.sku, name: productTitle(t.product, 'ru') } : null,
      order: t.order ? { id: t.order.id, number: t.order.order_number } : null,
      messages: t.messages.map((m) => ({ id: m.id, author: m.author, staff: m.staff?.name ?? null, text: m.text, created_at: m.created_at })),
    };
  }

  /** The shop's reply: the customer gets it in «Личные» and as a bot message with «Открыть и ответить». */
  async staffReply(staff: staff_users, id: string, raw: string) {
    const t = await this.staffThread(staff, id);
    await this.prisma.$transaction((tx) => this.sendStaff(tx, staff, t, raw.trim(), 'reply'));
    return this.staffOne(staff, id);
  }

  /**
   * One message of the shop: saved in the request; the customer gets it in «Личные» and as a bot message with
   * «Открыть и ответить». close: the request is closed (with an optional last message) and the customer is asked to rate.
   */
  private async sendStaff(tx: Prisma.TransactionClient, staff: staff_users, t: ThreadRow & { user: { telegram_user_id: bigint; language: string | null } }, text: string, kind: 'reply' | 'close') {
    const lang = langOf(t.user.language);
    const m = text ? await tx.support_messages.create({ data: { thread_id: t.id, author: 'staff', staff_user_id: staff.id, text } }) : null;
    const now = new Date();
    await tx.support_threads.update({
      where: { id: t.id },
      data:
        kind === 'close'
          ? { status: 'closed', closed_at: now, closed_by: staff.id, customer_unread: { increment: 1 }, ...(m ? { last_message_at: now } : {}) }
          : { status: 'answered', closed_at: null, closed_by: null, last_message_at: now, customer_unread: { increment: 1 } },
    });
    await this.notifications.toCustomer(tx, {
      userId: t.user_id,
      chatId: t.user.telegram_user_id,
      orderId: t.order_id ?? undefined,
      category: 'personal',
      template: kind === 'close' ? 'support.closed' : 'support.reply',
      payload: { order_number: t.order?.order_number ?? '', lang, thread_id: t.id, thread_no: supportNo(t.number), topic: t.topic, answer: text, open_path: `/support/${t.id}`, open_button: 'support' },
      dedupKey: kind === 'close' ? `support-close:${t.id}:${now.getTime()}` : `support:${m!.id}`,
    });
    // the text is never copied into the audit log (it may hold health data, D-40)
    await this.audit.log({ staffId: staff.id, action: kind === 'close' ? 'support.close' : 'support.reply', entityType: 'support_thread', entityId: t.id, after: { topic: t.topic } }, tx);
  }

  /** 6б-Б: «Закрыть обращение» — with an optional last message; the customer is asked to rate the answer. */
  async staffClose(staff: staff_users, id: string, raw?: string) {
    const t = await this.staffThread(staff, id);
    if (t.status === 'closed') return this.staffOne(staff, id);
    await this.prisma.$transaction((tx) => this.sendStaff(tx, staff, t, (raw ?? '').trim(), 'close'));
    return this.staffOne(staff, id);
  }

  /** 6б-Б: «Написать покупателю» from the order card — a request about this order, started by the shop. */
  async staffStart(staff: staff_users, orderId: string, raw: string) {
    const order = await this.prisma.orders.findUnique({ where: { id: orderId }, include: { user: true } });
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found' });
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.support_threads.create({ data: { user_id: order.user_id, topic: 'order', order_id: order.id, started_by: 'staff', lang: langOf(order.user.language) } });
      const t = await tx.support_threads.findUniqueOrThrow({ where: { id: created.id }, include: { ...THREAD_INCLUDE, user: true } });
      await this.sendStaff(tx, staff, t, raw.trim(), 'reply');
      return t.id;
    });
    return this.staffOne(staff, id);
  }

  /** 6б-Б: the requests about one order (the order card shows them). */
  async staffForOrder(staff: staff_users, orderId: string) {
    const rows = await this.prisma.support_threads.findMany({
      where: { order_id: orderId, ...(seesMedical(staff) ? {} : { topic: { not: 'medical' } }) },
      orderBy: { last_message_at: 'desc' },
    });
    return rows.map((t) => ({ id: t.id, number: supportNo(t.number), topic: t.topic, status: t.status, last_message_at: t.last_message_at }));
  }

  /** The «Обращения» badge in the menu: questions waiting for the shop that this employee may see. */
  async staffWaiting(staff: staff_users) {
    return { open: await this.prisma.support_threads.count({ where: { status: 'open', ...(seesMedical(staff) ? {} : { topic: { not: 'medical' } }) } }) };
  }
}

export class SupportCreateDto {
  @ApiProperty({ enum: SUPPORT_TOPIC_CODES }) @IsIn(SUPPORT_TOPIC_CODES as unknown as string[]) topic!: SupportTopic;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(SUPPORT_TEXT_MAX) text!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() product_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() order_id?: string;
}

export class SupportRateDto {
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) rating!: number;
}

export class SupportCloseDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(SUPPORT_TEXT_MAX) text?: string;
}

export class SupportStartDto {
  @ApiProperty() @IsUUID() order_id!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(SUPPORT_TEXT_MAX) text!: string;
}

export class SupportTextDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(SUPPORT_TEXT_MAX) text!: string;
}

class SupportListQuery {
  @ApiPropertyOptional({ enum: ['open', 'answered', 'closed'] }) @IsOptional() @IsIn(['open', 'answered', 'closed']) status?: 'open' | 'answered' | 'closed';
}

@ApiTags('support')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('support/threads')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.support.list(auth.user.id);
  }

  /** 403 DAILY_LIMIT after 10 questions a day. */
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: SupportCreateDto) {
    return this.support.create(auth.user.id, dto);
  }

  @Get(':id')
  one(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.support.one(auth.user.id, id);
  }

  /** 409 THREAD_CLOSED: a closed request takes no more messages. */
  @Post(':id/messages')
  reply(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SupportTextDto) {
    return this.support.reply(auth.user.id, id, dto.text);
  }

  @Post(':id/rating')
  @HttpCode(200)
  rate(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SupportRateDto) {
    return this.support.rate(auth.user.id, id, dto.rating);
  }
}

@ApiTags('staff: support')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/support')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get('threads')
  @RequirePermission('support.view')
  list(@CurrentStaff() me: StaffContext, @Query() q: SupportListQuery) {
    return this.support.staffList(me.staff, q.status ?? 'open');
  }

  @Get('waiting')
  @RequirePermission('support.view')
  waiting(@CurrentStaff() me: StaffContext) {
    return this.support.staffWaiting(me.staff);
  }

  @Get('threads/:id')
  @RequirePermission('support.view')
  one(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.support.staffOne(me.staff, id);
  }

  @Post('threads/:id/reply')
  @HttpCode(200)
  @RequirePermission('support.answer')
  reply(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SupportTextDto) {
    return this.support.staffReply(me.staff, id, dto.text);
  }

  @Post('threads/:id/close')
  @HttpCode(200)
  @RequirePermission('support.answer')
  close(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SupportCloseDto) {
    return this.support.staffClose(me.staff, id, dto?.text);
  }

  /** 6б-Б: «Написать покупателю» from the order card. */
  @Post('threads')
  @RequirePermission('support.answer')
  start(@CurrentStaff() me: StaffContext, @Body() dto: SupportStartDto) {
    return this.support.staffStart(me.staff, dto.order_id, dto.text);
  }

  @Get('orders/:orderId')
  @RequirePermission('support.view')
  forOrder(@CurrentStaff() me: StaffContext, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.support.staffForOrder(me.staff, orderId);
  }
}


import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { memoryStorage } from 'multer';
import { AnalyticsService } from '../analytics/analytics.module';
import { BotSecretGuard } from '../bot-internal/bot-internal.module';
import { formatUzs, tashkentDateTime } from '../common/tashkent';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { OrdersService } from '../orders/orders.service';
import { RECEIPT_MAX_BYTES, RECEIPT_REJECT_REASONS, RECEIPT_TYPES, receiptsDir, type ReceiptRejectCode } from '../orders/receipts';
import { PrismaService } from '../prisma/prisma.service';
import { MANUAL_PAYMENT_METHODS, SettingsService } from '../settings/settings.service';
import { AdminOrdersService } from './admin-orders';
import { AuditService } from './audit.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from './staff-auth';

/** After a rejection the customer has at least this long to pay or send another receipt before the reservation ends. */
const RESEND_WINDOW_MS = 2 * 3600_000;

type ReceiptError = 'NOT_REGISTERED' | 'ORDER_NOT_FOUND' | 'ORDER_PAID' | 'ORDER_CANCELLED' | 'NOT_CARD_TRANSFER' | 'RESERVATION_EXPIRED';
const refuse = (code: ReceiptError) => new ConflictException({ code, message: code });

function telegramId(raw: unknown): bigint {
  const s = String(raw ?? '');
  if (!/^\d{1,20}$/.test(s)) throw new BadRequestException('telegram_id must be digits');
  return BigInt(s);
}

/**
 * 3.1, «Скриншот чека в боте». The bot is only a messenger: every rule lives here.
 * - Only the order's owner may send a receipt, and only for an order still waiting for a card transfer.
 * - A receipt counts as «Я оплатил(а)» (if the customer has not pressed it yet), so the order is not auto-cancelled
 *   while the money is checked — exactly like the button. Nothing else about the reservation changes.
 * - «Подтвердить оплату» from the bot is the admin panel's action (AdminOrdersService.confirmPayment): status, stock,
 *   customer message, audit log. Only employees whose role may confirm payments (orders.payment).
 * - A rejection keeps the receipt (with its reason), turns «Я оплатил(а)» off again so the customer can pay or send a
 *   new receipt, and tells the customer why.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly orders: OrdersService,
    private readonly adminOrders: AdminOrdersService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** The customer's order the receipt is for: the one from the link, else their latest one waiting for a transfer. */
  async target(rawTelegramId: unknown, orderId?: string | null) {
    const user = await this.prisma.users.findUnique({ where: { telegram_user_id: telegramId(rawTelegramId) } });
    if (!user || user.status !== 'active') throw refuse('NOT_REGISTERED');
    const order = orderId
      ? await this.prisma.orders.findFirst({ where: { id: orderId, user_id: user.id }, include: { payments: { include: { method: true } } } })
      : await this.prisma.orders.findFirst({
          where: { user_id: user.id, status: { in: ['new', 'awaiting_payment'] }, payment_status: 'payment_pending', payments: { some: { method: { code: 'card_transfer' } } } },
          orderBy: { created_at: 'desc' },
          include: { payments: { include: { method: true } } },
        });
    if (!order) throw refuse('ORDER_NOT_FOUND');
    if (order.payment_status === 'payment_success') throw refuse('ORDER_PAID');
    if (order.status === 'cancelled') throw refuse('ORDER_CANCELLED');
    const method = order.payments.find((p) => p.status === 'payment_pending')?.method.code;
    if (!method || !(MANUAL_PAYMENT_METHODS as readonly string[]).includes(method)) throw refuse('NOT_CARD_TRANSFER');
    return { user, order: { id: order.id, order_number: order.order_number, total_uzs: Number(order.total_uzs) }, lang: user.language };
  }

  /** /start rc_<order>: tells the bot which order the next photo is for (or why it cannot be accepted). */
  async start(rawTelegramId: unknown, orderId: string | null) {
    const { order, lang } = await this.target(rawTelegramId, orderId);
    return { order_id: order.id, order_number: order.order_number, total_uzs: order.total_uzs, lang };
  }

  /** The bot downloaded a photo / file from the customer: store it, count it as «Я оплатил(а)», and say who checks it. */
  async receive(
    rawTelegramId: unknown,
    body: { order_id?: string | null; file_unique_id?: string; file_id?: string; mime?: string },
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('file is required');
    if (file.size > RECEIPT_MAX_BYTES) throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'Receipt is larger than 10 MB' });
    const mime = String(body.mime || file.mimetype || '').toLowerCase();
    const ext = RECEIPT_TYPES[mime];
    if (!ext) throw new BadRequestException({ code: 'FILE_TYPE', message: 'Only a photo or a PDF' });
    const uniqueId = String(body.file_unique_id ?? '').slice(0, 128);
    const fileId = String(body.file_id ?? '').slice(0, 256);
    if (!uniqueId || !fileId) throw new BadRequestException('file_unique_id and file_id are required');

    const { user, order, lang } = await this.target(rawTelegramId, body.order_id || null);
    const hours = await this.settings.getOrDefault('payment_check_hours');
    const checkHours = Number(await this.settings.getOrDefault('payment_check_reminder_hours')) || 3;
    const base = { order_id: order.id, order_number: order.order_number, total_uzs: order.total_uzs, lang, check_hours: hours, check_within_hours: checkHours };

    const same = await this.prisma.payment_receipts.findUnique({ where: { order_id_telegram_file_unique_id: { order_id: order.id, telegram_file_unique_id: uniqueId } } });
    if (same) return { ...base, result: 'duplicate' as const, receipt_id: same.id, staff: [] };

    // «Я оплатил(а)» first: it refuses a cancelled or expired order under the order lock, before anything is stored
    try {
      await this.orders.reportBankTransferPaid(user.id, order.id, undefined, { notifyStaff: false });
    } catch (e) {
      const code = (e as { response?: { code?: string } }).response?.code;
      if (code === 'RESERVATION_EXPIRED' || code === 'ORDER_CANCELLED') throw refuse(code);
      throw e;
    }

    const id = randomUUID();
    const key = `${order.id}/${id}.${ext}`;
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.buffer, { mode: 0o600 });
    try {
      await this.prisma.payment_receipts.create({
        data: { id, order_id: order.id, user_id: user.id, file_key: key, mime, size_bytes: file.size, telegram_file_unique_id: uniqueId, telegram_file_id: fileId },
      });
    } catch (e) {
      // the same file sent twice at the same moment: the first one is kept
      if ((e as { code?: string }).code === 'P2002') {
        const first = await this.prisma.payment_receipts.findUniqueOrThrow({ where: { order_id_telegram_file_unique_id: { order_id: order.id, telegram_file_unique_id: uniqueId } } });
        return { ...base, result: 'duplicate' as const, receipt_id: first.id, staff: [] };
      }
      throw e;
    }
    await this.analytics.track(user.id, 'receipt_sent', { order_id: order.id, file: ext });

    const staff = await this.prisma.staff_users.findMany({ where: { status: 'active', role: { in: ['admin', 'manager'] } }, orderBy: { created_at: 'asc' } });
    const customer = [user.first_name, user.last_name].filter(Boolean).join(' ');
    return {
      ...base,
      result: 'saved' as const,
      receipt_id: id,
      // staff messages are in Russian, like the other staff notifications
      caption: `Чек по заказу №${order.order_number}\nСумма: ${formatUzs(order.total_uzs)} сум, перевод на карту\nКлиент: ${customer}\nПрислан: ${tashkentDateTime(new Date())}`,
      staff: staff.filter((s) => can(s.role, 'orders.payment')).map((s) => ({ telegram_id: s.telegram_user_id.toString() })),
    };
  }

  /** «Подтвердить оплату» in the bot = the admin panel's confirmation. */
  async confirm(rawTelegramId: unknown, receiptId: string) {
    const staff = await this.staffFor(rawTelegramId);
    const receipt = await this.prisma.payment_receipts.findUnique({ where: { id: receiptId }, include: { order: true, reviewer: true } });
    if (!receipt) throw new NotFoundException('Receipt not found');
    if (receipt.status !== 'pending') return this.decided(receipt);
    if (receipt.order.payment_status === 'payment_success') {
      // confirmed in the admin panel (or by another receipt) meanwhile: this receipt is simply marked confirmed
      await this.prisma.payment_receipts.updateMany({ where: { id: receiptId, status: 'pending' }, data: { status: 'confirmed', reviewed_by: staff.id, reviewed_at: new Date() } });
      return { result: 'already_paid' as const, order_number: receipt.order.order_number };
    }
    // marks this order's pending receipts confirmed too (see AdminOrdersService.confirmPayment)
    await this.adminOrders.confirmPayment({ sessionId: 'telegram-bot', staff }, receipt.order_id, 'Оплата подтверждена по чеку в боте');
    await this.analytics.track(receipt.user_id, 'receipt_confirmed', { order_id: receipt.order_id });
    return { result: 'confirmed' as const, order_number: receipt.order.order_number };
  }

  /** «Отклонить»: a reason from the list (code) or typed by the employee (text). */
  async reject(rawTelegramId: unknown, receiptId: string, reason: { code?: string; text?: string }) {
    const staff = await this.staffFor(rawTelegramId);
    const code = reason.code as ReceiptRejectCode | undefined;
    const text = code && code in RECEIPT_REJECT_REASONS ? null : String(reason.text ?? '').trim().slice(0, 300);
    if (!code && !text) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'Pick or type a reason' });
    const outcome = await this.prisma.$transaction(async (tx) => {
      const receipt = await tx.payment_receipts.findUnique({ where: { id: receiptId }, include: { order: true, reviewer: true, user: true } });
      if (!receipt) throw new NotFoundException('Receipt not found');
      const order = await this.lifecycle.lockOrder(tx, receipt.order_id);
      const fresh = await tx.payment_receipts.findUniqueOrThrow({ where: { id: receiptId }, include: { order: true, reviewer: true } });
      if (fresh.status !== 'pending') return this.decided(fresh);
      if (order.payment_status === 'payment_success') return { result: 'already_paid' as const, order_number: order.order_number };
      const lang = receipt.user.language === 'uz' ? 'uz' : 'ru';
      const shown = text || RECEIPT_REJECT_REASONS[code!][lang];
      const now = new Date();
      await tx.payment_receipts.update({ where: { id: receiptId }, data: { status: 'rejected', reject_reason: text || RECEIPT_REJECT_REASONS[code!].ru, reviewed_by: staff.id, reviewed_at: now } });
      const waiting = order.status !== 'cancelled' && (await tx.payment_receipts.count({ where: { order_id: order.id, status: 'pending' } })) === 0;
      if (waiting) {
        // «Я оплатил(а)» is off again: the order waits for the payment, with time left to send a new receipt
        await tx.manual_payment_confirmations.updateMany({ where: { payment: { order_id: order.id, status: 'payment_pending' }, customer_confirmed_at: { not: null } }, data: { customer_confirmed_at: null } });
        const minUntil = new Date(now.getTime() + RESEND_WINDOW_MS);
        if (!order.reserved_until || order.reserved_until < minUntil) await tx.orders.update({ where: { id: order.id }, data: { reserved_until: minUntil } });
        await tx.notifications.create({
          data: {
            user_id: receipt.user_id,
            chat_id: receipt.user.telegram_user_id,
            kind: 'service',
            template: 'order.receipt_rejected',
            payload: { order_number: order.order_number, reason: shown, open_path: `/orders/${order.id}/pay`, lang },
          },
        });
      }
      await this.audit.log(
        { staffId: staff.id, action: 'order.receipt_rejected', entityType: 'order', entityId: order.id, before: { receipt: receiptId, status: 'pending' }, after: { status: 'rejected', reason: text || code, via: 'bot' } },
        tx,
      );
      return { result: 'rejected' as const, order_number: order.order_number, user_id: receipt.user_id, order_id: order.id, reason: text || RECEIPT_REJECT_REASONS[code!].ru };
    });
    if (outcome.result === 'rejected') await this.analytics.track(outcome.user_id, 'receipt_rejected', { order_id: outcome.order_id, reason: code ?? 'other' });
    return outcome.result === 'rejected' ? { result: outcome.result, order_number: outcome.order_number, reason: outcome.reason } : outcome;
  }

  /** Admin panel: the receipts of an order, newest first. */
  async list(orderId: string) {
    const rows = await this.prisma.payment_receipts.findMany({ where: { order_id: orderId }, orderBy: { created_at: 'desc' }, include: { reviewer: { select: { name: true } } } });
    return rows.map((r) => ({
      id: r.id,
      mime: r.mime,
      size_bytes: r.size_bytes,
      status: r.status,
      reject_reason: r.reject_reason,
      reviewed_by: r.reviewer?.name ?? null,
      reviewed_at: r.reviewed_at,
      created_at: r.created_at,
    }));
  }

  async file(orderId: string, receiptId: string) {
    const r = await this.prisma.payment_receipts.findFirst({ where: { id: receiptId, order_id: orderId } });
    if (!r) throw new NotFoundException('Receipt not found');
    return { mime: r.mime, data: await readFile(this.pathOf(r.file_key)) };
  }

  private decided(r: { status: string; order: { order_number: string }; reviewer: { name: string } | null; reject_reason: string | null }) {
    return { result: r.status === 'confirmed' ? ('already_confirmed' as const) : ('already_rejected' as const), order_number: r.order.order_number, by: r.reviewer?.name ?? null, reason: r.reject_reason };
  }

  /** The employee pressing a button in the bot: active, and allowed to confirm payments (manager, admin). */
  private async staffFor(rawTelegramId: unknown) {
    const staff = await this.prisma.staff_users.findUnique({ where: { telegram_user_id: telegramId(rawTelegramId) } });
    if (!staff || staff.status !== 'active' || !can(staff.role, 'orders.payment')) {
      throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: 'Only a manager or an admin can check receipts' });
    }
    return staff;
  }

  private pathOf(key: string): string {
    const root = receiptsDir(this.config);
    const path = resolve(join(root, key));
    if (!path.startsWith(root + sep)) throw new BadRequestException('Bad receipt path');
    return path;
  }
}

/** Called by the bot only (X-Bot-Secret), like the rest of /api/internal/bot. */
@ApiExcludeController()
@UseGuards(BotSecretGuard)
@Controller('internal/bot/receipts')
export class BotReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Post('start')
  @HttpCode(200)
  start(@Body() body: { telegram_id?: unknown; order_id?: string | null }) {
    const id = body.order_id && /^[0-9a-f-]{36}$/i.test(body.order_id) ? body.order_id : null;
    return this.receipts.start(body.telegram_id, id);
  }

  @Post()
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: RECEIPT_MAX_BYTES, files: 1 } }))
  receive(@Body() body: { telegram_id?: unknown; order_id?: string; file_unique_id?: string; file_id?: string; mime?: string }, @UploadedFile() file?: Express.Multer.File) {
    const orderId = body.order_id && /^[0-9a-f-]{36}$/i.test(body.order_id) ? body.order_id : null;
    return this.receipts.receive(body.telegram_id, { ...body, order_id: orderId }, file);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: { telegram_id?: unknown }) {
    return this.receipts.confirm(body.telegram_id, id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: { telegram_id?: unknown; code?: string; text?: string }) {
    return this.receipts.reject(body.telegram_id, id, { code: body.code, text: body.text });
  }
}

@ApiTags('staff: orders')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/orders/:orderId/receipts')
export class AdminReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get()
  @RequirePermission('orders.view')
  list(@Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.receipts.list(orderId);
  }

  /** The picture or PDF itself; never cached by the browser or a proxy (it holds a name and a card number). */
  @Get(':id/file')
  @RequirePermission('orders.view')
  async file(@Param('orderId', new ParseUUIDPipe()) orderId: string, @Param('id', new ParseUUIDPipe()) id: string, @Res() res: Response) {
    const { mime, data } = await this.receipts.file(orderId, id);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${id.slice(0, 8)}.${RECEIPT_TYPES[mime] ?? 'bin'}"`);
    res.send(data);
  }
}

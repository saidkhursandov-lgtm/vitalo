import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, type staff_users } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AnalyticsService } from '../analytics/analytics.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { productTitle } from '../waitlist/waitlist';
import { SYSTEM_COMMON, cartDataBlock, costUsd, tashkentMonthStart } from './ai';
import {
  CHAT_SCHEMA,
  CHAT_TOPICS,
  FAILED_TEXT,
  MAX_CLARIFY,
  RED_FLAG_TEXT,
  SYSTEM_CHAT,
  chatDataBlock,
  checkChatAnswer,
  hasRedFlag,
  isGoalTopic,
  scrubPii,
  topicOrder,
  type ChatCandidate,
  type ChatData,
  type ChatEvidence,
  type ChatTopic,
} from './ai-chat';
import { AI_MODEL, AiCallError, type AiModel } from './ai-client';
import { DOCTOR_LINE, LEVEL_LABELS, LEVELS, bestLevel, type Fit, type Goal, type Level } from './ai-goal';
import { AiService } from './ai.service';
import { tashkentDayStart, type Lang } from './compat';
import { CompatService, langOf, type Item } from './compat.service';
import { withParents } from './knowledge';

const MAX_TOKENS = 2000;
/** a conversation continues while it was used within this time; later «Спросить VITALO AI» starts a new one */
const OPEN_MS = 24 * 3600_000;
const HISTORY = 12;

export interface ChatProductView {
  product_id: string;
  name: string;
  /** null — a question of compatibility or another one: no label */
  fit: Fit | null;
  level: Level | null;
  level_text: string | null;
  text: string;
  in_cart: boolean;
}

/** What the app shows for a message; the AI ones keep it in `payload`. */
export interface ChatMessageView {
  id: string;
  role: 'user' | 'ai';
  kind: string;
  text: string | null;
  created_at: Date;
  topic?: ChatTopic;
  products?: ChatProductView[];
  steps?: string[];
  followups?: string[];
  options?: string[];
  /** «Если проблема держится дольше 3–4 недель — обратитесь к врачу» under an answer about a goal */
  doctor?: string | null;
  /** show «Спросить специалиста VITALO» */
  specialist?: boolean;
}

export interface ChatView {
  id: string;
  number: string;
  questions: number;
  messages: ChatMessageView[];
}

export interface ChatState {
  available: boolean;
  consent: boolean;
  left_today: number;
  max_chars: number;
  max_turns: number;
  /** the goals of the suggested questions, those of the cart first */
  topics: Goal[];
  chat: ChatView | null;
}

type Payload = Omit<ChatMessageView, 'id' | 'role' | 'kind' | 'text' | 'created_at'>;

/** AI-20261112-0001 — the Tashkent date of the conversation and its number of the day. */
export function chatNumberPrefix(at: Date): string {
  const local = new Date(at.getTime() + 5 * 3600_000);
  return `AI-${local.toISOString().slice(0, 10).replace(/-/g, '')}-`;
}

/**
 * D-70: «Спросить VITALO AI о корзине». The customer's questions and the answers are kept (phones and e-mails cut out),
 * 12 months by default («Настройки → VITALO AI»); the customer may delete a conversation at once. Questions are counted
 * in the daily limit of the chat (`chat_daily_limit`, with «Поможет ли этот набор…») and in the monthly budget.
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly busy = new Set<string>();
  private purging = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly compat: CompatService,
    private readonly ai: AiService,
    private readonly analytics: AnalyticsService,
    @Inject(AI_MODEL) private readonly model: AiModel,
  ) {}

  private doneToday(userId: string, now: Date) {
    return this.prisma.ai_requests.count({ where: { user_id: userId, scenario: { in: ['cart_goal', 'cart_chat'] }, status: 'ok', created_at: { gte: tashkentDayStart(now) } } });
  }

  private async view(chatId: string): Promise<ChatView> {
    const c = await this.prisma.ai_chats.findUniqueOrThrow({ where: { id: chatId }, include: { messages: { orderBy: { created_at: 'asc' } } } });
    return {
      id: c.id,
      number: c.number,
      questions: c.questions,
      messages: c.messages.map((m) => ({ id: m.id, role: m.role as 'user' | 'ai', kind: m.kind, text: m.text, created_at: m.created_at, ...((m.payload ?? {}) as Payload) })),
    };
  }

  private async openChat(userId: string, now: Date) {
    return this.prisma.ai_chats.findFirst({
      where: { user_id: userId, deleted_at: null, purged_at: null, updated_at: { gte: new Date(now.getTime() - OPEN_MS) } },
      orderBy: { created_at: 'desc' },
    });
  }

  /** GET /compat/ai/chat */
  async state(userId: string, now = new Date()): Promise<ChatState> {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { ai_chat_consent_at: true } });
    const s = await this.ai.settings();
    const [done, items, open] = await Promise.all([this.doneToday(userId, now), this.compat.cartItems(userId), this.openChat(userId, now)]);
    const subs = items.length
      ? await this.prisma.product_substances.findMany({ where: { product_id: { in: items.map((i) => i.product_id) } }, select: { substance: { select: { name_ru: true } } } })
      : [];
    return {
      available: s.enabled && this.model.ready(),
      consent: !!user.ai_chat_consent_at,
      left_today: Math.max(0, s.chat_daily_limit - done),
      max_chars: s.chat_max_chars,
      max_turns: s.chat_max_turns,
      topics: topicOrder(subs.map((x) => x.substance.name_ru)),
      chat: open ? await this.view(open.id) : null,
    };
  }

  /** POST /compat/ai/chat/consent — the consent that says the conversation is kept (D-70); it is the VITALO AI consent too. */
  async consent(userId: string): Promise<ChatState> {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { ai_consent_at: true, ai_chat_consent_at: true } });
    if (!user.ai_chat_consent_at) {
      const now = new Date();
      await this.prisma.users.update({ where: { id: userId }, data: { ai_chat_consent_at: now, ai_consent_at: user.ai_consent_at ?? now } });
      await this.analytics.track(userId, 'ai_consent', { scenario: 'chat' });
    }
    return this.state(userId);
  }

  /**
   * POST /compat/ai/chat/message. 403 CONSENT_REQUIRED, 400 EMPTY / TOO_LONG, 404 (not the customer's conversation),
   * 409 BUSY / CHAT_FULL, 429 AI_DAILY_LIMIT, 503 AI_UNAVAILABLE (off, no key, the budget is spent). A failed or rejected
   * answer is a message «не получилось ответить» with «Спросить специалиста», not an error.
   */
  async send(userId: string, dto: { chat_id?: string; text: string; suggestion?: string }, now = new Date()): Promise<{ chat: ChatView; left_today: number }> {
    if (this.busy.has(userId)) throw new HttpException({ code: 'BUSY', message: 'The question is already being answered' }, HttpStatus.CONFLICT);
    this.busy.add(userId);
    try {
      return await this.run(userId, dto, now);
    } finally {
      this.busy.delete(userId);
    }
  }

  private async run(userId: string, dto: { chat_id?: string; text: string; suggestion?: string }, now: Date) {
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { ai_chat_consent_at: true, language: true } });
    if (!user.ai_chat_consent_at) throw new ForbiddenException({ code: 'CONSENT_REQUIRED', message: 'The customer has not agreed to VITALO AI conversations yet' });
    const lang = langOf(user.language);
    const s = await this.ai.settings();
    const text = scrubPii((dto.text ?? '').trim(), lang);
    if (!text) throw new BadRequestException({ code: 'EMPTY', message: 'The question is empty' });
    if (text.length > s.chat_max_chars) throw new BadRequestException({ code: 'TOO_LONG', message: `No more than ${s.chat_max_chars} characters` });
    const unavailable = (reason: string) => new HttpException({ code: 'AI_UNAVAILABLE', message: `VITALO AI cannot answer now: ${reason}` }, HttpStatus.SERVICE_UNAVAILABLE);
    if (!s.enabled || !this.model.ready()) throw unavailable('off');

    let chat = dto.chat_id ? await this.prisma.ai_chats.findFirst({ where: { id: dto.chat_id, user_id: userId, deleted_at: null, purged_at: null } }) : null;
    if (dto.chat_id && !chat) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such conversation' });
    if (chat && chat.questions >= s.chat_max_turns) throw new HttpException({ code: 'CHAT_FULL', message: `No more than ${s.chat_max_turns} questions in a conversation` }, HttpStatus.CONFLICT);

    const red = hasRedFlag(text);
    const done = await this.doneToday(userId, now);
    if (!red && done >= s.chat_daily_limit) {
      await this.analytics.track(userId, 'compat_ai_limit', { scenario: 'cart_chat', limit: s.chat_daily_limit });
      throw new HttpException({ code: 'AI_DAILY_LIMIT', message: `No more than ${s.chat_daily_limit} questions a day` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!red) {
      const spent = await this.prisma.ai_requests.aggregate({ _sum: { cost_usd: true }, where: { created_at: { gte: tashkentMonthStart(now) } } });
      if (Number(spent._sum.cost_usd ?? 0) >= s.monthly_budget_usd) throw unavailable('budget');
    }

    const items = await this.compat.cartItems(userId);
    chat ??= await this.createChat(userId, lang, items, now);
    const history = await this.prisma.ai_chat_messages.findMany({ where: { chat_id: chat.id }, orderBy: { created_at: 'asc' } });
    await this.prisma.ai_chat_messages.create({ data: { chat_id: chat.id, role: 'user', kind: 'question', text } });

    const finish = async (kind: string, outcome: string, msg: { text: string; payload: Payload; model?: string; input?: number; output?: number; cost?: number; latency?: number; error?: string }, topic?: ChatTopic) => {
      await this.prisma.ai_chat_messages.create({
        data: {
          chat_id: chat!.id,
          role: 'ai',
          kind,
          text: msg.text,
          payload: msg.payload as Prisma.InputJsonValue,
          model: msg.model ?? null,
          input_tokens: msg.input ?? 0,
          output_tokens: msg.output ?? 0,
          cost_usd: new Prisma.Decimal((msg.cost ?? 0).toFixed(6)),
          latency_ms: msg.latency ?? null,
          error: msg.error ?? null,
        },
      });
      await this.prisma.ai_chats.update({
        where: { id: chat!.id },
        data: { questions: { increment: 1 }, outcome, ...(topic ? { topic } : {}), ...(msg.model ? { model: msg.model } : {}), cost_usd: { increment: new Prisma.Decimal((msg.cost ?? 0).toFixed(6)) } },
      });
      await this.analytics.track(userId, 'compat_ai_chat', { kind: outcome, topic: topic ?? null, lang, empty_cart: !items.length, suggestion: dto.suggestion ?? null });
      const left = Math.max(0, s.chat_daily_limit - (await this.doneToday(userId, now)));
      return { chat: await this.view(chat!.id), left_today: left };
    };

    if (red) return finish('red_flag', 'red_flag', { text: RED_FLAG_TEXT[lang], payload: { specialist: true } });

    const { data, refs } = await this.chatData(items, lang, history, text);
    const log = { scenario: 'cart_chat', user_id: userId, set_key: items.map((i) => i.product_id).sort().join(',') || null, lang, model: s.goal_model };
    const started = Date.now();
    let completion;
    try {
      completion = await this.model.complete({ model: s.goal_model, system: `${SYSTEM_COMMON}\n\n${SYSTEM_CHAT}`, data: chatDataBlock(data), schema: CHAT_SCHEMA, maxTokens: MAX_TOKENS });
    } catch (e) {
      const code = e instanceof AiCallError ? e.code : 'error';
      this.logger.warn(`VITALO AI conversation failed: ${code}`);
      const latency = Date.now() - started;
      await this.prisma.ai_requests.create({ data: { ...log, status: code === 'timeout' ? 'timeout' : 'error', latency_ms: latency, error: code } });
      return finish('failed', 'failed', { text: FAILED_TEXT[lang], payload: { specialist: true }, model: s.goal_model, latency, error: code });
    }
    const latency = Date.now() - started;
    const cost = costUsd(s.goal_model, completion.inputTokens, completion.outputTokens);
    const checked = completion.outcome === 'ok' ? checkChatAnswer(completion.json, data) : ({ ok: false, error: completion.outcome } as const);
    await this.prisma.ai_requests.create({
      data: {
        ...log,
        status: checked.ok ? 'ok' : 'invalid',
        input_tokens: completion.inputTokens,
        output_tokens: completion.outputTokens,
        cost_usd: new Prisma.Decimal(cost.toFixed(6)),
        latency_ms: latency,
        error: checked.ok ? null : checked.error,
        rejected_text: checked.ok ? null : JSON.stringify(completion.json ?? null).slice(0, 4000),
      },
    });
    const meta = { model: s.goal_model, input: completion.inputTokens, output: completion.outputTokens, cost, latency };
    if (!checked.ok) return finish('failed', 'failed', { text: FAILED_TEXT[lang], payload: { specialist: true }, ...meta, error: checked.error });

    const a = checked.answer;
    if (a.kind === 'red_flag') return finish('red_flag', 'red_flag', { text: RED_FLAG_TEXT[lang], payload: { specialist: true }, ...meta }, a.goal);
    const products: ChatProductView[] = a.products.map((p) => {
      const lines = isGoalTopic(a.goal) ? data.evidence.filter((e) => e.ref === p.ref && e.goal === a.goal) : [];
      const cand = isGoalTopic(a.goal) ? data.candidates.filter((c) => c.ref === p.ref && c.goal === a.goal) : [];
      const level = p.fit ? bestLevel([...lines, ...cand].map((l) => ({ substance: '', level: l.level, helps: '', not_helps: '' }))) : null;
      const r = refs.get(p.ref)!;
      return { product_id: r.id, name: r.name, fit: p.fit, level, level_text: level ? LEVEL_LABELS[level][lang] : null, text: p.text, in_cart: r.in_cart };
    });
    const payload: Payload =
      a.kind === 'clarify'
        ? { topic: a.goal, options: a.options }
        : {
            topic: a.goal,
            products,
            steps: a.steps,
            followups: a.followups,
            doctor: a.kind === 'answer' && isGoalTopic(a.goal) ? DOCTOR_LINE[lang] : null,
            specialist: a.kind === 'answer',
          };
    const outcome = a.kind === 'answer' ? 'answered' : a.kind;
    return finish(a.kind, outcome, { text: a.text, payload, ...meta }, a.goal);
  }

  private async createChat(userId: string, lang: Lang, items: Item[], now: Date) {
    const prefix = chatNumberPrefix(now);
    const cart = items.map((i) => ({ product_id: i.product_id, sku: i.sku, name: lang === 'uz' ? i.name_uz : i.name_ru }));
    for (let attempt = 0; attempt < 5; attempt++) {
      const n = (await this.prisma.ai_chats.count({ where: { number: { startsWith: prefix } } })) + 1 + attempt;
      try {
        return await this.prisma.ai_chats.create({ data: { number: `${prefix}${String(n).padStart(4, '0')}`, user_id: userId, lang, cart, empty_cart: !items.length } });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    throw new HttpException({ code: 'BUSY', message: 'Try again' }, HttpStatus.CONFLICT);
  }

  /**
   * The data of the model: the cart (products and approved rules, as in the compatibility check), the approved
   * «вещество → цель» rows of its substances (a form counts for its substance), or — with an empty cart — products of the
   * catalogue whose substances the doctor approved for a goal; the conversation so far and the question.
   */
  async chatData(items: Item[], lang: Lang, history: { role: string; kind: string; text: string | null; payload: unknown }[], question: string) {
    const refs = new Map<string, { id: string; name: string; in_cart: boolean }>();
    const [subs, evidence] = await Promise.all([
      this.prisma.substances.findMany({ where: { enabled: true }, select: { id: true, name_ru: true, name_uz: true, parent_id: true } }),
      this.prisma.goal_evidence.findMany({ where: { status: 'approved' } }),
    ]);
    const names = new Map(subs.map((s) => [s.id, s]));
    const parentOf = new Map(subs.map((s) => [s.id, s.parent_id]));
    const subName = (id: string) => {
      const n = names.get(id);
      return n ? (lang === 'uz' ? `${n.name_uz} (${n.name_ru})` : n.name_ru) : id;
    };
    const lineOf = (e: (typeof evidence)[number]) => ({
      goal: e.goal as Goal,
      level: e.level as Level,
      helps: lang === 'uz' ? e.helps_uz : e.helps_ru,
      not_helps: lang === 'uz' ? e.not_helps_uz : e.not_helps_ru,
    });

    let cartBlock = '';
    const cart: ChatData['cart'] = [];
    const ev: ChatEvidence[] = [];
    const candidates: ChatCandidate[] = [];
    if (items.length) {
      const { data: cd, refs: cartRefs } = await this.ai.cartData(items, lang);
      cartBlock = cartDataBlock(cd);
      for (const p of cd.cart) {
        cart.push({ ref: p.ref, name: p.name });
        refs.set(p.ref, { id: cartRefs.get(p.ref)!, name: p.name, in_cart: true });
      }
      const rows = await this.prisma.product_substances.findMany({ where: { product_id: { in: items.map((i) => i.product_id) } }, select: { product_id: true, substance_id: true } });
      for (const item of items) {
        const all = withParents(rows.filter((r) => r.product_id === item.product_id && names.has(r.substance_id)).map((r) => r.substance_id), parentOf);
        for (const e of evidence.filter((x) => all.has(x.substance_id))) ev.push({ ref: item.sku, substance: subName(e.substance_id), ...lineOf(e) });
      }
    } else if (evidence.length) {
      // an empty cart: up to 3 products of the catalogue per goal, the best level first
      const childrenOf = (id: string) => subs.filter((s) => s.parent_id === id).map((s) => s.id);
      const sorted = [...evidence].sort((a, b) => LEVELS.indexOf(a.level as Level) - LEVELS.indexOf(b.level as Level));
      const perGoal = new Map<string, number>();
      for (const e of sorted) {
        if ((perGoal.get(e.goal) ?? 0) >= 3) continue;
        const products = await this.prisma.products.findMany({
          where: { status: 'active', substances: { some: { substance_id: { in: [e.substance_id, ...childrenOf(e.substance_id)] } } } },
          select: { id: true, sku: true, name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true, substances: { select: { substance_id: true } } },
          orderBy: { sku: 'asc' },
          take: 2,
        });
        for (const p of products) {
          if ((perGoal.get(e.goal) ?? 0) >= 3) break;
          const name = productTitle(p, lang);
          candidates.push({ ref: p.sku, name, substances: p.substances.map((x) => subName(x.substance_id)), goal: e.goal as Goal, level: e.level as Level, helps: lang === 'uz' ? e.helps_uz : e.helps_ru });
          refs.set(p.sku, { id: p.id, name, in_cart: false });
          perGoal.set(e.goal, (perGoal.get(e.goal) ?? 0) + 1);
        }
      }
    }

    const turns = history
      .filter((m) => m.text)
      .slice(-HISTORY)
      .map((m) => {
        const pl = (m.payload ?? {}) as Payload;
        const extra = pl.products?.length ? ` (${pl.products.map((p) => `${p.name}: ${p.fit ?? '—'}`).join('; ')})` : pl.options?.length ? ` [варианты: ${pl.options.join(' / ')}]` : '';
        return { role: m.role === 'user' ? ('user' as const) : ('ai' as const), text: `${m.text}${extra}` };
      });
    const clarifies = history.filter((m) => m.role === 'ai' && m.kind === 'clarify').length;
    const data: ChatData = { lang, cartBlock, cart, evidence: ev, candidates, history: turns, clarifyLeft: Math.max(0, MAX_CLARIFY - clarifies), question };
    return { data, refs };
  }

  /** DELETE /compat/ai/chat/:id — the customer deletes a conversation: its texts are wiped at once (D-70). */
  async remove(userId: string, chatId: string, now = new Date()) {
    const chat = await this.prisma.ai_chats.findFirst({ where: { id: chatId, user_id: userId, deleted_at: null } });
    if (!chat) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such conversation' });
    await this.prisma.$transaction([
      this.prisma.ai_chat_messages.updateMany({ where: { chat_id: chatId }, data: { text: null, payload: Prisma.DbNull } }),
      this.prisma.ai_chats.update({ where: { id: chatId }, data: { deleted_at: now } }),
    ]);
    return { ok: true };
  }

  @Interval('ai-chat-purge', 3600_000)
  async tick() {
    if (this.purging) return;
    this.purging = true;
    try {
      const n = await this.purge();
      if (n) this.logger.log(`VITALO AI: texts of ${n} conversation(s) wiped after the retention period`);
    } catch (e) {
      this.logger.error('VITALO AI conversation purge failed', e as Error);
    } finally {
      this.purging = false;
    }
  }

  /** The texts of conversations older than `chat_retention_days` are wiped; the numbers, topic and cost stay. */
  async purge(now = new Date()): Promise<number> {
    const s = await this.ai.settings();
    const cut = new Date(now.getTime() - s.chat_retention_days * 24 * 3600_000);
    const old = await this.prisma.ai_chats.findMany({ where: { created_at: { lt: cut }, purged_at: null }, select: { id: true }, take: 500 });
    if (!old.length) return 0;
    const ids = old.map((c) => c.id);
    await this.prisma.$transaction([
      this.prisma.ai_chat_messages.updateMany({ where: { chat_id: { in: ids } }, data: { text: null, payload: Prisma.DbNull } }),
      this.prisma.ai_chats.updateMany({ where: { id: { in: ids } }, data: { purged_at: now } }),
    ]);
    return ids.length;
  }
}

// ---------------- «VITALO AI → Переписки» (admin) ----------------

export const CHAT_OUTCOMES = ['answered', 'clarify', 'off_topic', 'red_flag', 'failed'] as const;

@Injectable()
export class AiChatAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Months that have conversations, newest first ('2026-11'), Tashkent time. */
  async months(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ m: string }[]>`
      SELECT DISTINCT to_char(created_at + interval '5 hours', 'YYYY-MM') AS m FROM ai_chats ORDER BY m DESC`;
    return rows.map((r) => r.m);
  }

  async list(f: AiChatFilter) {
    const months = await this.months();
    const now = chatNumberPrefix(new Date());
    const month = f.month ?? months[0] ?? `${now.slice(3, 7)}-${now.slice(7, 9)}`;
    const [y, m] = month.split('-').map(Number);
    const from = tashkentMonthStart(new Date(Date.UTC(y, m - 1, 15)));
    const to = tashkentMonthStart(new Date(Date.UTC(y, m, 15)));
    const q = f.q?.trim();
    const where: Prisma.ai_chatsWhereInput = {
      created_at: { gte: from, lt: to },
      ...(f.lang ? { lang: f.lang } : {}),
      ...(f.topic ? { topic: f.topic } : {}),
      ...(f.outcome ? { outcome: f.outcome } : {}),
      ...(f.empty === 'yes' ? { empty_cart: true } : f.empty === 'no' ? { empty_cart: false } : {}),
      ...(f.review === 'none' ? { review: null } : f.review ? { review: f.review } : {}),
      ...(q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { user: { first_name: { contains: q, mode: 'insensitive' } } },
              { user: { last_name: { contains: q, mode: 'insensitive' } } },
              { user: { username: { contains: q, mode: 'insensitive' } } },
              { user: { phone: { contains: q } } },
            ],
          }
        : {}),
    };
    const [rows, total, cost] = await Promise.all([
      this.prisma.ai_chats.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: 200,
        include: { user: { select: { id: true, first_name: true, last_name: true, username: true } } },
      }),
      this.prisma.ai_chats.count({ where }),
      this.prisma.ai_chats.aggregate({ where, _sum: { cost_usd: true } }),
    ]);
    return {
      month,
      months: months.includes(month) ? months : [month, ...months],
      total,
      cost_usd: Number(cost._sum.cost_usd ?? 0),
      items: rows.map((c) => ({
        id: c.id,
        number: c.number,
        created_at: c.created_at,
        lang: c.lang,
        topic: c.topic,
        outcome: c.outcome,
        questions: c.questions,
        empty_cart: c.empty_cart,
        cost_usd: Number(c.cost_usd),
        model: c.model,
        review: c.review,
        deleted: !!c.deleted_at,
        purged: !!c.purged_at,
        user: { id: c.user.id, name: [c.user.first_name, c.user.last_name].filter(Boolean).join(' '), username: c.user.username },
      })),
    };
  }

  async get(me: staff_users, id: string) {
    const c = await this.prisma.ai_chats.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, first_name: true, last_name: true, username: true } },
        reviewer: { select: { name: true } },
        messages: { orderBy: { created_at: 'asc' } },
      },
    });
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such conversation' });
    // who opened a customer's conversation is in the audit log (D-70)
    await this.audit.log({ staffId: me.id, action: 'ai_chat.viewed', entityType: 'ai_chat', entityId: id });
    return {
      id: c.id,
      number: c.number,
      created_at: c.created_at,
      updated_at: c.updated_at,
      lang: c.lang,
      topic: c.topic,
      outcome: c.outcome,
      questions: c.questions,
      empty_cart: c.empty_cart,
      cart: c.cart,
      cost_usd: Number(c.cost_usd),
      model: c.model,
      review: c.review,
      review_note: c.review_note,
      reviewed_by: c.reviewer?.name ?? null,
      reviewed_at: c.reviewed_at,
      deleted: !!c.deleted_at,
      purged: !!c.purged_at,
      user: { id: c.user.id, name: [c.user.first_name, c.user.last_name].filter(Boolean).join(' '), username: c.user.username },
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        kind: m.kind,
        text: m.text,
        created_at: m.created_at,
        model: m.model,
        cost_usd: Number(m.cost_usd),
        latency_ms: m.latency_ms,
        error: m.error,
        ...((m.payload ?? {}) as Payload),
      })),
    };
  }

  async review(me: staff_users, id: string, dto: AiChatReviewDto) {
    const before = await this.prisma.ai_chats.findUnique({ where: { id }, select: { review: true, review_note: true } });
    if (!before) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such conversation' });
    const review = dto.review === 'none' ? null : dto.review;
    const note = dto.note?.trim() || null;
    await this.prisma.$transaction(async (tx) => {
      await tx.ai_chats.update({ where: { id }, data: { review, review_note: note, reviewed_by: review ? me.id : null, reviewed_at: review ? new Date() : null } });
      await this.audit.log({ staffId: me.id, action: 'ai_chat.reviewed', entityType: 'ai_chat', entityId: id, before, after: { review, review_note: note } }, tx);
    });
    return { ok: true };
  }
}

// ---------------- controllers ----------------

export class ChatMessageDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() chat_id?: string;
  @ApiProperty() @IsString() @MaxLength(1000) text!: string;
  /** the suggested question that was tapped (analytics only) */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) suggestion?: string;
}

export class AiChatFilter {
  @ApiPropertyOptional({ example: '2026-11' }) @IsOptional() @Matches(/^\d{4}-\d{2}$/) month?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['ru', 'uz']) lang?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn([...CHAT_TOPICS]) topic?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn([...CHAT_OUTCOMES]) outcome?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['yes', 'no']) empty?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['ok', 'wrong', 'none']) review?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class AiChatReviewDto {
  @ApiProperty({ enum: ['ok', 'wrong', 'none'] }) @IsIn(['ok', 'wrong', 'none']) review!: 'ok' | 'wrong' | 'none';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

@ApiTags('compat')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('compat/ai/chat')
export class AiChatController {
  constructor(private readonly chat: AiChatService) {}

  @Get()
  state(@CurrentAuth() auth: AuthContext) {
    return this.chat.state(auth.user.id);
  }

  @Post('consent')
  @HttpCode(200)
  consent(@CurrentAuth() auth: AuthContext) {
    return this.chat.consent(auth.user.id);
  }

  @Post('message')
  @HttpCode(200)
  send(@CurrentAuth() auth: AuthContext, @Body() dto: ChatMessageDto) {
    return this.chat.send(auth.user.id, dto);
  }

  @Delete(':id')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.remove(auth.user.id, id);
  }
}

@ApiTags('staff: compat')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/ai/chats')
export class AdminAiChatsController {
  constructor(private readonly chats: AiChatAdminService) {}

  @Get()
  @RequirePermission('compat.answer')
  list(@Query() f: AiChatFilter) {
    return this.chats.list(f);
  }

  @Get(':id')
  @RequirePermission('compat.answer')
  get(@CurrentStaff() me: StaffContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.chats.get(me.staff, id);
  }

  @Patch(':id')
  @RequirePermission('compat.answer')
  review(@CurrentStaff() me: StaffContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AiChatReviewDto) {
    return this.chats.review(me.staff, id, dto);
  }
}


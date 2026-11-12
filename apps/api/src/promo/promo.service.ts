import { Injectable } from '@nestjs/common';
import { Prisma, PromoType } from '@prisma/client';
import { formatUzs } from '../common/tashkent';
import { DeliveryQuote } from '../delivery/delivery-quote';
import { DeliveryService } from '../delivery/delivery.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { BonusService } from '../bonus/bonus.service';
import { BonusBlock, bonusSpend, cashbackOf } from '../bonus/bonus-rules';
import { purchaseCosts } from './purchase-costs';
import { eligibleLines, goodsDiscount, GoodsDiscount, normalizePromoCode, PricingLine, PROMO_CODE_RE, PromoGuard, PromoKind, PromoTargets } from './pricing';

type Db = Prisma.TransactionClient | PrismaService;

/** Why a code does not work; each has a customer text in RU and UZ (promoMessage). */
export type PromoRejectReason =
  | 'not_found'
  | 'disabled'
  | 'not_started'
  | 'expired'
  | 'first_order'
  | 'already_used'
  | 'limit_reached'
  | 'min_order'
  | 'not_applicable'
  | 'delivery_free';

export interface PromoRejection {
  ok: false;
  code: string;
  reason: PromoRejectReason;
  message_ru: string;
  message_uz: string;
}

export interface PromoApplied {
  ok: true;
  code: string;
  promotion_id: string;
  kind: PromoKind;
  value: number;
  description_ru: string | null;
  description_uz: string | null;
  /** Goods discount (zero for free delivery). */
  goods: GoodsDiscount;
}

export type PromoResult = PromoApplied | PromoRejection;

/** Statuses that hold an activation: reserved (order created) and consumed (paid). Rolled back = free again. */
const HOLDING = ['reserved', 'consumed'] as const;

export function promoMessage(reason: PromoRejectReason, minOrderUzs?: number | null): { ru: string; uz: string } {
  const sum = formatUzs(minOrderUzs ?? 0);
  const texts: Record<PromoRejectReason, { ru: string; uz: string }> = {
    not_found: { ru: 'Такого промокода нет', uz: 'Bunday promokod yo‘q' },
    disabled: { ru: 'Промокод больше не действует', uz: 'Promokod endi amal qilmaydi' },
    not_started: { ru: 'Промокод ещё не начал действовать', uz: 'Promokod hali amal qilmaydi' },
    expired: { ru: 'Срок действия промокода истёк', uz: 'Promokodning amal qilish muddati tugagan' },
    first_order: { ru: 'Промокод только для первого заказа', uz: 'Promokod faqat birinchi buyurtma uchun' },
    already_used: { ru: 'Промокод уже использован', uz: 'Promokod allaqachon ishlatilgan' },
    limit_reached: { ru: 'Промокод закончился: все активации использованы', uz: 'Promokod tugadi: barcha faollashtirishlar ishlatilgan' },
    min_order: { ru: `Промокод действует при заказе от ${sum} сум`, uz: `Promokod ${sum} so‘mlik buyurtmadan boshlab amal qiladi` },
    not_applicable: { ru: 'Промокод не подходит к товарам в корзине', uz: 'Promokod savatdagi mahsulotlarga mos kelmaydi' },
    delivery_free: { ru: 'Доставка уже бесплатная — промокод не нужен', uz: 'Yetkazib berish allaqachon bepul — promokod kerak emas' },
  };
  return texts[reason];
}

const reject = (code: string, reason: PromoRejectReason, minOrderUzs?: number | null): PromoRejection => {
  const m = promoMessage(reason, minOrderUzs);
  return { ok: false, code, reason, message_ru: m.ru, message_uz: m.uz };
};

/**
 * 3.3: checks a promo code against a customer's lines. With `lock` (inside the order transaction) the promotion row is
 * locked first (SELECT … FOR UPDATE), so two orders at the same moment count each other's activations and the
 * «всего» limit is never exceeded. Free delivery is checked by the caller (it needs the delivery quote).
 */
@Injectable()
export class PromoCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly delivery: DeliveryService,
    private readonly bonusService: BonusService,
  ) {}

  async guard(): Promise<PromoGuard> {
    return this.settings.getOrDefault('promo_guard');
  }

  /**
   * Pricing lines with brand, «old price» and purchase cost (purchaseCosts). 3.7: a line in a running sale carries its
   * regular price and the sale's percent (the promo code then looks at them).
   */
  async pricingLines(db: Db, lines: { product_id: string; qty: number; unit_price_uzs: number; list_price_uzs?: number; campaign?: LineCampaign | null }[]): Promise<PricingLine[]> {
    const ids = lines.map((l) => l.product_id);
    const [products, costs] = await Promise.all([
      db.products.findMany({ where: { id: { in: ids } }, select: { id: true, brand_id: true, old_price_uzs: true } }),
      purchaseCosts(db, ids),
    ]);
    return lines.map((l) => {
      const p = products.find((x) => x.id === l.product_id);
      return {
        product_id: l.product_id,
        brand_id: p?.brand_id ?? null,
        qty: l.qty,
        unit_price_uzs: l.unit_price_uzs,
        old_price_uzs: p?.old_price_uzs == null ? null : Number(p.old_price_uzs),
        cost_uzs: costs.get(l.product_id) ?? null,
        ...(l.campaign && { list_price_uzs: l.list_price_uzs ?? l.unit_price_uzs, campaign_pct: l.campaign.discount_pct }),
      };
    });
  }

  async evaluate(db: Db, userId: string, input: string, lines: PricingLine[], opts: { lock?: boolean } = {}): Promise<PromoResult> {
    const code = normalizePromoCode(input);
    if (!PROMO_CODE_RE.test(code)) return reject(code, 'not_found');
    const row = await db.promo_codes.findUnique({ where: { code }, include: { promotion: { include: { targets: true } } } });
    if (!row) return reject(code, 'not_found');
    const p = row.promotion;
    if (opts.lock) await db.$queryRaw`SELECT id FROM promotions WHERE id = ${p.id}::uuid FOR UPDATE`;

    const now = new Date();
    if (row.status !== 'active' || p.status !== 'active') return reject(code, 'disabled');
    if (p.start_at > now) return reject(code, 'not_started');
    if (p.end_at <= now) return reject(code, 'expired');
    if (p.first_order_only && !(await this.delivery.hasNoOrders(userId, db))) return reject(code, 'first_order');

    const perCustomer = p.per_customer_limit ?? 1;
    const mine = await db.promotion_usages.count({ where: { promotion_id: p.id, user_id: userId, status: { in: [...HOLDING] } } });
    if (mine >= perCustomer) return reject(code, 'already_used');
    if (p.global_limit != null) {
      const all = await db.promotion_usages.count({ where: { promotion_id: p.id, status: { in: [...HOLDING] } } });
      if (all >= p.global_limit) return reject(code, 'limit_reached');
    }

    const goodsTotal = lines.reduce((s, l) => s + l.unit_price_uzs * l.qty, 0);
    const minOrder = p.min_order_uzs == null ? null : Number(p.min_order_uzs);
    if (minOrder != null && goodsTotal < minOrder) return reject(code, 'min_order', minOrder);

    const targets: PromoTargets = {
      scope: p.scope_type === 'brand' ? 'brand' : p.scope_type === 'product' ? 'product' : 'order',
      product_ids: p.targets.map((t) => t.product_id).filter((x): x is string => !!x),
      brand_ids: p.targets.map((t) => t.brand_id).filter((x): x is string => !!x),
    };
    const eligible = eligibleLines(lines, targets);
    if (!eligible.length) return reject(code, 'not_applicable');

    const kind = p.type as PromoType as PromoKind;
    const value = Number(p.value);
    const goods = kind === 'free_delivery' ? { total_uzs: 0, lines: [], capped: false } : goodsDiscount(kind, value, eligible, await this.guard());
    // every eligible line already sits at its margin floor: the code gives nothing here
    if (kind !== 'free_delivery' && goods.total_uzs <= 0) return reject(code, 'not_applicable');

    return { ok: true, code, promotion_id: p.id, kind, value, description_ru: p.description_ru, description_uz: p.description_uz, goods };
  }

  /**
   * THE order calculation (cart, checkout preview, order creation): goods at their prices (3.7: a line in a running sale
   * already at its sale price — the difference to the regular price is the «Акция …» line) → promo code → (bonuses,
   * D-71) → delivery → total. The free-delivery threshold uses goods AFTER the promo (Master TZ §9). A code that
   * does not fit comes back as `promo_rejection` and the totals are computed without it.
   */
  async calculate(db: Db, userId: string, priced: PricedInput[], opts: { address?: { region_id: string; city_id: string } | null; code?: string | null; lock?: boolean; useBonus?: boolean }): Promise<Calculation> {
    const goods = priced.reduce((s, l) => s + l.unit_price_uzs * l.qty, 0);
    const campaigns = campaignLines(priced);
    const campaignDiscount = campaigns.reduce((s, c) => s + c.amount_uzs, 0);
    let applied: PromoApplied | null = null;
    let rejection: PromoRejection | null = null;
    let pricing: PricingLine[] | null = null;
    const pricingOnce = async () => (pricing ??= await this.pricingLines(db, priced));
    if (opts.code) {
      const r = await this.evaluate(db, userId, opts.code, await pricingOnce(), { lock: opts.lock });
      if (r.ok) applied = r;
      else rejection = r;
    }

    const discount = applied?.goods.total_uzs ?? 0;
    let delivery: DeliveryQuote | null = opts.address ? await this.delivery.quote(opts.address.region_id, opts.address.city_id, goods - discount, db, { userId }) : null;
    let deliverySaved = 0;
    if (applied?.kind === 'free_delivery' && delivery) {
      if (delivery.is_free) {
        rejection = reject(applied.code, 'delivery_free');
        applied = null;
      } else {
        deliverySaved = delivery.cost_uzs;
        delivery = promoFreeDelivery(delivery);
      }
    }

    // 3.10-А (D-71): bonuses — after the promo code (never together with one); the delivery is always money.
    // The order transaction locks the account row, so two orders never spend the same bonuses.
    const settings = await this.bonusService.settings();
    const balance = priced.length ? await this.bonusService.balance(db, userId, { lock: opts.lock }) : 0;
    const needLines = settings.enabled && balance > 0 && !applied && priced.length > 0;
    const spend = bonusSpend({ balance_uzs: balance, lines: needLines ? await pricingOnce() : [], guard: await this.guard(), settings, promoApplied: !!applied, use: !!opts.useBonus });
    const bonus = spend.used_uzs;

    const deliveryCost = delivery?.cost_uzs ?? 0;
    const goodsPaid = goods - discount - bonus;
    const cashbackPct = settings.enabled ? settings.cashback_pct : 0;
    const bonusView: BonusView = {
      balance_uzs: balance,
      available_uzs: spend.available_uzs,
      use: !!opts.useBonus && spend.used_uzs > 0,
      used_uzs: bonus,
      blocked: spend.blocked,
      cashback_pct: cashbackPct,
      cashback_uzs: cashbackOf(goodsPaid, cashbackPct),
      max_spend_pct: settings.max_spend_pct,
    };
    const byLine = new Map((applied?.goods.lines ?? []).map((l) => [l.product_id, l]));
    const promo: PromoView | null = applied && {
      code: applied.code,
      kind: applied.kind,
      value: applied.value,
      discount_uzs: applied.kind === 'free_delivery' ? deliverySaved : discount,
      free_delivery: applied.kind === 'free_delivery',
      capped: applied.goods.capped,
      description_ru: applied.description_ru,
      description_uz: applied.description_uz,
      ...appliedText(applied.code, applied.kind === 'free_delivery' ? deliverySaved : discount, applied.kind === 'free_delivery'),
    };

    const snapshot: PricingSnapshot = {
      version: 2,
      lines: priced.map((l) => {
        const d = byLine.get(l.product_id);
        return {
          product_id: l.product_id,
          qty: l.qty,
          unit_price_uzs: l.unit_price_uzs,
          list_price_uzs: l.campaign ? (l.list_price_uzs ?? l.unit_price_uzs) : l.unit_price_uzs,
          campaign_id: l.campaign?.id ?? null,
          campaign_discount_uzs: l.campaign ? ((l.list_price_uzs ?? l.unit_price_uzs) - l.unit_price_uzs) * l.qty : 0,
          line_total_uzs: l.unit_price_uzs * l.qty,
          promo_discount_uzs: d?.discount_uzs ?? 0,
          promo_capped: d?.capped ?? false,
          bonus_uzs: spend.lines.get(l.product_id) ?? 0,
          // the basis of a refund and of the fiscal receipt: what the customer really paid (bonuses are a discount too)
          paid_line_total_uzs: l.unit_price_uzs * l.qty - (d?.discount_uzs ?? 0) - (spend.lines.get(l.product_id) ?? 0),
        };
      }),
      goods_total_uzs: goods,
      goods_list_total_uzs: goods + campaignDiscount,
      campaigns,
      discounts: applied
        ? [{ kind: 'promo', promotion_id: applied.promotion_id, code: applied.code, type: applied.kind, value: applied.value, target: applied.kind === 'free_delivery' ? 'delivery' : 'goods', amount_uzs: promo!.discount_uzs, capped: applied.goods.capped }]
        : [],
      bonus_used_uzs: bonus,
      cashback_pct: cashbackPct,
      delivery: {
        tariff_uzs: delivery?.tariff_uzs ?? 0,
        cost_uzs: deliveryCost,
        free_reason: !delivery?.is_free ? null : delivery.promo ? 'promo' : delivery.first_order ? 'first_order' : 'threshold',
      },
      total_uzs: goodsPaid + deliveryCost,
      guard: await this.guard(),
    };

    return {
      totals: { goods_list_total_uzs: goods + campaignDiscount, campaign_discount_uzs: campaignDiscount, goods_total_uzs: goods, discount_total_uzs: discount, bonus_used_uzs: bonus, goods_paid_uzs: goodsPaid, delivery_cost_uzs: deliveryCost, total_uzs: goodsPaid + deliveryCost },
      delivery,
      promo,
      promo_rejection: rejection,
      applied,
      snapshot,
      bonus: bonusView,
    };
  }
}

export interface PricedInput {
  product_id: string;
  qty: number;
  unit_price_uzs: number;
  /** 3.7: the line is in a running sale: unit_price_uzs is its sale price, this is the regular one */
  list_price_uzs?: number;
  campaign?: LineCampaign | null;
}

/** 3.7: the sale of a line (CampaignsService.running). */
export interface LineCampaign {
  id: string;
  title_ru: string;
  title_uz: string | null;
  skin: string;
  discount_pct: number;
}

/** 3.7: «Акция 11.11: −X сум» — one line per sale in the order, in the order of the lines. */
export type CampaignLine = {
  promotion_id: string;
  title_ru: string;
  title_uz: string | null;
  skin: string;
  amount_uzs: number;
};

export function campaignLines(priced: PricedInput[]): CampaignLine[] {
  const out: CampaignLine[] = [];
  for (const l of priced) {
    if (!l.campaign) continue;
    const amount = ((l.list_price_uzs ?? l.unit_price_uzs) - l.unit_price_uzs) * l.qty;
    if (amount <= 0) continue;
    const row = out.find((c) => c.promotion_id === l.campaign!.id);
    if (row) row.amount_uzs += amount;
    else out.push({ promotion_id: l.campaign.id, title_ru: l.campaign.title_ru, title_uz: l.campaign.title_uz, skin: l.campaign.skin, amount_uzs: amount });
  }
  return out;
}

/** What the customer sees about the applied code. */
export interface PromoView {
  code: string;
  kind: PromoKind;
  value: number;
  /** Goods discount, or the delivery cost saved by a free-delivery code. */
  discount_uzs: number;
  free_delivery: boolean;
  /** Margin protection made the discount smaller than the code promises. */
  capped: boolean;
  description_ru: string | null;
  description_uz: string | null;
  message_ru: string;
  message_uz: string;
}

/**
 * The frozen calculation kept in orders.pricing_json (never recalculated after the order is created).
 * Version 2 (3.7): the regular price of each line, its sale and the «Акция …» lines; goods_total_uzs stays the goods at
 * the prices paid before the promo code (sale prices), so older readers keep working.
 */
export interface PricingSnapshot {
  version: 1 | 2;
  lines: { product_id: string; qty: number; unit_price_uzs: number; list_price_uzs?: number; campaign_id?: string | null; campaign_discount_uzs?: number; line_total_uzs: number; promo_discount_uzs: number; promo_capped: boolean; bonus_uzs?: number; paid_line_total_uzs: number }[];
  goods_total_uzs: number;
  /** 3.7: goods at regular prices (goods_total_uzs + the sales) */
  goods_list_total_uzs?: number;
  campaigns?: CampaignLine[];
  discounts: { kind: 'promo'; promotion_id: string; code: string; type: PromoKind; value: number; target: 'goods' | 'delivery'; amount_uzs: number; capped: boolean }[];
  bonus_used_uzs: number;
  /** 3.10-А: the cashback percent of the order (0 — VITALO Bonus off) */
  cashback_pct?: number;
  delivery: { tariff_uzs: number; cost_uzs: number; free_reason: 'threshold' | 'first_order' | 'promo' | null };
  total_uzs: number;
  guard: PromoGuard;
}

export interface Calculation {
  totals: { goods_list_total_uzs: number; campaign_discount_uzs: number; goods_total_uzs: number; discount_total_uzs: number; bonus_used_uzs: number; goods_paid_uzs: number; delivery_cost_uzs: number; total_uzs: number };
  delivery: DeliveryQuote | null;
  promo: PromoView | null;
  promo_rejection: PromoRejection | null;
  applied: PromoApplied | null;
  snapshot: PricingSnapshot;
  bonus: BonusView;
}

/** 3.10-А: VITALO Bonus of the cart / checkout. */
export interface BonusView {
  balance_uzs: number;
  /** The most that may be spent on this order now (0 — see blocked). */
  available_uzs: number;
  /** «Списать бонусы» is on and something is spent. */
  use: boolean;
  used_uzs: number;
  blocked: BonusBlock | null;
  /** «+N сум на бонусный счёт» after the delivery. */
  cashback_pct: number;
  cashback_uzs: number;
  max_spend_pct: number;
}

/** «Промокод VITALO10 применён (−20 000 сум)»; free delivery without a district yet: «(доставка бесплатно)». */
export function appliedText(code: string, amount: number, freeDelivery: boolean): { message_ru: string; message_uz: string } {
  if (freeDelivery && !amount) return { message_ru: `Промокод ${code} применён (доставка бесплатно)`, message_uz: `${code} promokodi qo‘llandi (yetkazib berish bepul)` };
  return { message_ru: `Промокод ${code} применён (−${formatUzs(amount)} сум)`, message_uz: `${code} promokodi qo‘llandi (−${formatUzs(amount)} so‘m)` };
}

/** The tariff, delivered free by a promo code. */
export function promoFreeDelivery(quote: DeliveryQuote): DeliveryQuote {
  return {
    ...quote,
    cost_uzs: 0,
    is_free: true,
    remaining_for_free_uzs: 0,
    promo: true,
    message_ru: 'Промокод — доставка бесплатно',
    message_uz: 'Promokod — yetkazib berish bepul',
  };
}

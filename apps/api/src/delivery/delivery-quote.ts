import { formatUzs } from '../common/tashkent';

export interface Tariff {
  tariff_uzs: number;
  free_shipping_threshold_uzs: number;
  /** Delivery term in working days (null = not set). */
  min_days?: number | null;
  max_days?: number | null;
  note_ru?: string | null;
  note_uz?: string | null;
}

export interface DeliveryQuote extends Tariff {
  cost_uzs: number;
  is_free: boolean;
  remaining_for_free_uzs: number;
  message_ru: string;
  message_uz: string;
}

/**
 * Master TZ §9: the free-shipping threshold is checked against goods AFTER discounts and BEFORE bonuses
 * (bonuses never help reach it), so callers must pass exactly that amount.
 */
export function quoteDelivery(tariff: Tariff, goodsAfterDiscountsUzs: number): DeliveryQuote {
  const threshold = tariff.free_shipping_threshold_uzs;
  const isFree = goodsAfterDiscountsUzs >= threshold;
  const remaining = isFree ? 0 : threshold - goodsAfterDiscountsUzs;

  return {
    ...tariff,
    min_days: tariff.min_days ?? null,
    max_days: tariff.max_days ?? null,
    note_ru: tariff.note_ru ?? null,
    note_uz: tariff.note_uz ?? null,
    cost_uzs: isFree ? 0 : tariff.tariff_uzs,
    is_free: isFree,
    remaining_for_free_uzs: remaining,
    message_ru: isFree
      ? `Вы достигли ${formatUzs(threshold)} сум — доставка бесплатна`
      : `Добавьте ещё на ${formatUzs(remaining)} сум — доставка будет бесплатной`,
    message_uz: isFree
      ? `Siz ${formatUzs(threshold)} so‘mga yetdingiz — yetkazib berish bepul`
      : `Yana ${formatUzs(remaining)} so‘mlik xarid qiling — yetkazib berish bepul bo‘ladi`,
  };
}

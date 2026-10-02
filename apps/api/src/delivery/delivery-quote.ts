import { formatUzs } from '../common/tashkent';

export interface Tariff {
  tariff_uzs: number;
  free_shipping_threshold_uzs: number;
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

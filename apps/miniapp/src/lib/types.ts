/** Shapes of API responses (apps/api). Money is integer UZS. */

export type Lang = 'ru' | 'uz';

export interface Named {
  name_ru: string;
  name_uz: string | null;
}

/** 2.1: optional short name (admin product card) for the cart, checkout and orders. */
export interface ShortNamed {
  name_ru: string;
  name_uz?: string | null;
  short_name_ru?: string | null;
  short_name_uz?: string | null;
}

export type OnlineProvider = 'payme' | 'click' | 'uzum';
export type OnlineMode = 'hidden' | 'soon' | 'test' | 'live';

export interface UserProfile {
  id: string;
  telegram_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  phone: string | null;
  language: Lang;
  marketing_opt_in: boolean;
}

export interface CategoryNode extends Named {
  id: string;
  slug: string;
  /** Products available to customers in this category and its subcategories. */
  product_count: number;
  children: CategoryNode[];
}

export interface LocalizedText {
  ru: string;
  uz: string;
}

/** `bank_transfer` is no longer offered at checkout (D-06) but old orders with it still open. */
export type PaymentMethodCode = 'card_transfer' | 'bank_transfer' | 'cod' | 'payme';

export interface CategoryTrees {
  need: CategoryNode[];
  product_type: CategoryNode[];
}

export interface ProductListItem extends Named {
  id: string;
  sku: string;
  short_name_ru?: string | null;
  short_name_uz?: string | null;
  /** 2.3: «Цитрат + B6» under the name; course_days — null when not filled or under 7 days */
  substance_form_ru?: string | null;
  substance_form_uz?: string | null;
  course_days?: number | null;
  brand: string;
  price_uzs: number;
  old_price_uzs: number | null;
  image_url: string | null;
  /** Thumbnail with JPEG fallback and size (null for products without photos). */
  image?: { webp: string; jpeg: string | null; width: number | null; height: number | null } | null;
  in_stock: boolean;
  /** D-60: nothing in Tashkent, but it can be ordered «под заказ» (from abroad — prepayment only) */
  cross_border?: boolean;
  /** D-61: from whom and how long: «Под заказ из США • 7–14 дней» or «Под заказ • 1–2 дня» */
  under_order?: UnderOrderTerms | null;
  /** 3.7: the product is in a running sale — price_uzs is the sale price, campaign.list_price_uzs the regular one */
  campaign?: ShopCampaign | null;
  /** 6а-В: the manual label «11.11», «Black Friday», «Хит», «Новинка» (a running sale's badge wins) */
  promo_label?: PromoLabel | null;
}

/** 3.7: «Акции»: the skin draws the badge and the price colour; «none» — only the two prices. */
export type CampaignSkin = 'none' | 'black_friday' | 'eleven_eleven' | 'sale';

export interface ShopCampaign {
  id: string;
  slug: string;
  skin: CampaignSkin;
  title_ru: string;
  title_uz: string | null;
  discount_pct: number;
  list_price_uzs: number;
  /** null — a sale without an end date (no countdown) */
  ends_at: string | null;
}

/** 3.7: a running sale for the home slide and the sale page. */
export interface CampaignSummary {
  id: string;
  slug: string;
  skin: CampaignSkin;
  title_ru: string;
  title_uz: string | null;
  ends_at: string | null;
  max_discount_pct: number;
  products_count: number;
}

export interface CampaignPage {
  campaign: CampaignSummary;
  items: ProductListItem[];
}

/** 3.7: «Акция 11.11: −X сум» in the cart, checkout and order. */
export interface CampaignLine {
  promotion_id: string;
  title_ru: string;
  title_uz: string | null;
  skin: CampaignSkin;
  amount_uzs: number;
}

/** 2.2: a card in «Проверенные бренды». `name` is the brand as written on the products. */
export interface BrandCard {
  id: string;
  slug: string;
  name: string;
  name_uz: string | null;
  /** Square WebP 400×400; null — the card shows the first letter. */
  logo_url: string | null;
  product_count: number;
}

/** 2.2: the brand page: logo, name, country and «Почему [бренд] в VITALO» on top, products below. */
export interface BrandPage extends BrandCard {
  country_ru: string | null;
  country_uz: string | null;
  why_vitalo_ru: string | null;
  why_vitalo_uz: string | null;
}

export interface ProductCard extends ProductListItem {
  /** D-60/D-61: «Под заказ из США • 7–14 дней» / «Под заказ • 1–2 дня» and the guarantee (null: in stock or not «под заказ») */
  cross_border_terms?: UnderOrderTerms | null;
  available_qty: number;
  /** 2.2: the brand page address; null — the brand has no page yet */
  brand_slug?: string | null;
  /** 2.3: «Почему [бренд] отобран в VITALO» */
  brand_name_ru?: string | null;
  brand_name_uz?: string | null;
  brand_why_ru?: string | null;
  brand_why_uz?: string | null;
  /** 2.3: expertise blocks; empty ones are not shown */
  pack_count?: number | null;
  std_bioavailability?: boolean;
  std_tested?: boolean;
  std_original?: boolean;
  halal_vege?: 'halal' | 'vege' | 'halal_vege' | 'none' | 'unknown' | null;
  shell_ru?: string | null;
  shell_uz?: string | null;
  market_advantage_percent?: number | null;
  doctor_verdict_ru?: string | null;
  doctor_verdict_uz?: string | null;
  manufacturer: string;
  country: string | null;
  form: string | null;
  short_description_ru: string | null;
  short_description_uz: string | null;
  composition_ru: string | null;
  composition_uz: string | null;
  nutrition_ru: string | null;
  nutrition_uz: string | null;
  directions_ru: string | null;
  directions_uz: string | null;
  warnings_ru: string | null;
  warnings_uz: string | null;
  media: {
    type: 'image' | 'document';
    url: string;
    url_jpeg?: string | null;
    thumb_url?: string | null;
    width?: number | null;
    height?: number | null;
    title: string | null;
    is_main: boolean;
  }[];
  categories: { id: string; slug: string; tree_type: 'need' | 'product_type'; name_ru: string; name_uz: string }[];
  similar: ProductListItem[];
  also_bought: ProductListItem[];
}

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface DeliveryQuote {
  tariff_uzs: number;
  free_shipping_threshold_uzs: number;
  cost_uzs: number;
  is_free: boolean;
  remaining_for_free_uzs: number;
  message_ru: string;
  message_uz: string;
  min_days?: number | null;
  max_days?: number | null;
  note_ru?: string | null;
  note_uz?: string | null;
  /** free because it is the customer's first order */
  first_order?: boolean;
  /** 3.3: free because of a free-delivery promo code */
  promo?: boolean;
}

/** 3.3: the applied promo code (the server computes everything; the app only shows it). */
export interface PromoView {
  code: string;
  kind: 'percent' | 'fixed' | 'free_delivery';
  value: number;
  /** goods discount, or the delivery cost saved by a free-delivery code */
  discount_uzs: number;
  free_delivery: boolean;
  /** the margin protection made the discount smaller than the code promises */
  capped: boolean;
  description_ru: string | null;
  description_uz: string | null;
  message_ru: string;
  message_uz: string;
}

/** 3.3: why a code does not fit, with the customer text. */
export interface PromoRejection {
  code: string;
  reason: string;
  message_ru: string;
  message_uz: string;
}

/** Delivery term in working days (null = not set for this city). */
export interface DeliveryEta {
  min_days: number | null;
  max_days: number | null;
  note_ru: string | null;
  note_uz: string | null;
}

export interface DaysRange {
  min_days: number;
  max_days: number;
}

/** /catalog/texts: everything editable in the admin panel that the shop shows. */
/** 2.4: «Как VITALO отбирает добавки»; 2.4 patch: a lead sentence and 3 cards «Не берём / Стандарт VITALO». */
export interface Manifest {
  enabled: boolean;
  title: LocalizedText;
  subtitle: LocalizedText;
  lead: LocalizedText;
  /** bad: «Не берём», empty = not shown; good: «Стандарт VITALO» */
  cards: { title: LocalizedText; bad: LocalizedText; good: LocalizedText }[];
}

export interface ShopInfo {
  product_disclaimer: LocalizedText;
  support_contact: string;
  support_url: string | null;
  payment_check_hours: { from: string; to: string };
  delivery_days_label: LocalizedText;
  delivery_terms: { tashkent: DaysRange | null; regions: DaysRange | null };
  home_content?: HomeContent;
  bonus_teaser?: { enabled: boolean; text: LocalizedText };
  /** 2.4: «Как VITALO отбирает добавки» (Настройки → Главная → Манифест). */
  manifest?: Manifest;
  /** Release 1 switches from Настройки → Оплата. */
  checkout?: { cod_max_total_uzs: number | null; show_online_soon: boolean; first_order_free_delivery: boolean; online?: Record<OnlineProvider, OnlineMode> };
}

export type TrustKey = 'original' | 'delivery' | 'documents' | 'payments';

/** Home page blocks from the admin panel (Настройки → Главная). */
export interface HomeContent {
  banner: { enabled: boolean; title: LocalizedText; subtitle: LocalizedText; button: LocalizedText };
  trust: { key: TrustKey; enabled: boolean; title: LocalizedText; text: LocalizedText }[];
  steps: { enabled: boolean; items: LocalizedText[] };
}

export type LegalCode = 'offer' | 'privacy';

export interface LegalDocument {
  code: LegalCode;
  version: string;
  text_ru: string;
  text_uz: string;
}

export interface LegalStatus {
  accepted: boolean;
  documents: { code: LegalCode; version: string; accepted: boolean }[];
}

export type CartWarning =
  | { code: 'price_changed'; product_id: string; old_price_uzs: number; new_price_uzs: number }
  | { code: 'campaign_ended'; product_id: string; old_price_uzs: number; new_price_uzs: number; campaign_title_ru?: string | null; campaign_title_uz?: string | null }
  | { code: 'qty_reduced'; product_id: string; requested_qty: number; available_qty: number }
  | { code: 'out_of_stock'; product_id: string }
  | { code: 'promo_removed'; product_id?: undefined; promo_code: string; reason: string; message_ru: string; message_uz: string };

export interface CartLine extends Named {
  short_name_ru?: string | null;
  short_name_uz?: string | null;
  form?: string | null;
  product_id: string;
  sku: string;
  brand: string;
  image_url: string | null;
  status: 'available' | 'unavailable';
  qty: number;
  available_qty: number;
  /** D-60: «Под заказ из США» */
  cross_border?: boolean;
  under_order?: UnderOrderMark | null;
  unit_price_uzs: number;
  line_total_uzs: number;
  /** 3.7: the regular price (equals unit_price_uzs outside a sale) */
  list_price_uzs?: number;
  campaign?: ShopCampaign | null;
}

export interface Cart {
  items: CartLine[];
  warnings: CartWarning[];
  goods_total_uzs: number;
  discount_total_uzs: number;
  items_count: number;
  can_checkout: boolean;
  delivery: DeliveryQuote | null;
  /** 3.3 */
  promo?: PromoView | null;
  /** 3.7: goods at regular prices and one line per sale */
  goods_list_total_uzs?: number;
  campaign_discount_uzs?: number;
  campaigns?: CampaignLine[];
  /** D-60: the cart has lines from the USA — the promised window counted from today */
  cross_border?: CrossBorderWindow | null;
}

/** D-61: «из США» (foreign, from_ru / from_uz) or a local supplier; older answers without kind — from the USA. */
export interface UnderOrderMark {
  kind?: 'local' | 'foreign';
  from_ru?: string | null;
  from_uz?: string | null;
}
export interface UnderOrderTerms extends UnderOrderMark {
  days_min: number;
  days_max: number;
  guarantee_days: number;
}

/** D-60: «Ожидаемая доставка: 18–25 ноября», YYYY-MM-DD; D-61: foreign — a line from abroad (prepayment only) */
export interface CrossBorderWindow {
  expected_from: string;
  expected_to: string;
  guarantee_days: number;
  foreign?: boolean;
  from_ru?: string | null;
  from_uz?: string | null;
}

export type CbStage = 'paid' | 'ordered' | 'shipped' | 'arrived_uz' | 'in_stock';

/** D-60/D-61: the tracking of an order with «под заказ» lines (kind local — paid → ordered → in stock). */
export interface CrossBorderTracking {
  stage: CbStage | null;
  kind?: 'local' | 'foreign';
  from_ru?: string | null;
  from_uz?: string | null;
  lines_waiting: number;
  expected_from: string | null;
  expected_to: string | null;
  steps: { stage: CbStage; done: boolean; at: string | null }[];
  delays: { at: string; expected_to: string | null; reason: string | null }[];
}

export interface Region extends Named {
  id: string;
  cities: (Named & { id: string })[];
}

export interface Address {
  id: string;
  label: string | null;
  region: Named & { id: string };
  city: Named & { id: string };
  address_text: string;
  /** 3.6: the point chosen on the map (null: typed by hand) */
  latitude: number | null;
  longitude: number | null;
  apartment: string | null;
  entrance: string | null;
  floor: string | null;
  landmark: string | null;
  is_primary: boolean;
}

export type OrderStatus =
  | 'new'
  | 'awaiting_payment'
  | 'paid'
  | 'picking'
  | 'handed_to_delivery'
  | 'in_transit'
  | 'delivered'
  | 'cancelled'
  | 'return';

export interface Totals {
  goods_total_uzs: number;
  discount_total_uzs: number;
  bonus_used_uzs: number;
  goods_paid_uzs: number;
  delivery_cost_uzs: number;
  total_uzs: number;
  /** 3.7: goods at regular prices (goods_total_uzs is at sale prices) and the sale discount */
  goods_list_total_uzs?: number;
  campaign_discount_uzs?: number;
}

export interface Order {
  id: string;
  order_number: string;
  status: OrderStatus;
  payment_status: 'payment_pending' | 'payment_success' | 'payment_failed' | 'payment_cancelled';
  created_at: string;
  reserved_until: string | null;
  recipient: { name: string; phone: string };
  delivery: { region: Named; city: Named; address_text: string; cost_uzs: number };
  customer_comment: string | null;
  items: (ShortNamed & { product_id: string; sku: string; qty: number; unit_price_uzs: number; line_total_uzs: number; list_price_uzs?: number; form?: string | null; image_url?: string | null; cross_border?: boolean; under_order?: UnderOrderMark | null })[];
  totals: Totals;
  /** D-60: lines «Под заказ из США» — stages and the promised window (null: none) */
  cross_border?: CrossBorderTracking | null;
  /** D-60: may the customer cancel the paid order «из США» now, and from which day by the guarantee */
  cross_border_cancel?: { allowed: boolean; reason: 'not_ordered' | 'guarantee' | null; guarantee_date: string | null } | null;
  /** 3.7: «Акция 11.11: −X сум», frozen at creation */
  campaigns?: CampaignLine[];
  /** 3.3: the order's promo code (frozen at creation) */
  promo?: { code: string; discount_uzs: number; free_delivery: boolean } | null;
  payment: { method: string; status: string; amount_uzs: number; customer_reported_paid_at: string | null } | null;
  can_cancel: boolean;
  delivery_eta?: DeliveryEta | null;
  history: { from_status: string | null; to_status: OrderStatus; reason: string | null; created_at: string }[];
  /** 3.2: «Как принимать ваш заказ» — after the payment (or the cash-on-delivery confirmation); null before or without memos */
  intake_guide?: IntakeGuide | null;
}

export interface IntakeGuideLine {
  product_id: string;
  name: string;
  text: string;
}
export interface IntakeGuide {
  ru: IntakeGuideLine[];
  uz: IntakeGuideLine[];
  footer: Record<Lang, string>;
}

/** 3.2: one entry of the notification centre (title and line already in the requested language). */
/** 3.2: «Заказы», «Акции и бонусы», «Сервисные». */
export type CentreTab = 'personal' | 'orders' | 'promo' | 'service';
export type CentreCounts = { unread: number; tabs: Record<CentreTab, number> };
/** One card per order (latest status, its steps, a note about the intake memo); other notices one card each. */
export interface CentreItem {
  id: string;
  tab: CentreTab;
  category: 'order' | 'waitlist' | 'promo' | 'compat' | 'personal';
  template: string;
  title: string;
  body: string;
  steps: string[];
  has_guide: boolean;
  path: string | null;
  read: boolean;
  created_at: string;
}
export interface CentreList extends CentreCounts {
  items: CentreItem[];
}

/** 3.2: the plaque on the home screen. */
export interface ActiveOrder {
  order: {
    id: string;
    order_number: string;
    status: OrderStatus;
    payment_method: string | null;
    payment_reported: boolean;
    can_pay: boolean;
    delivery_eta: DeliveryEta | null;
    /** D-60: a paid order waiting for the USA — its stage and the last promised day */
    cross_border_stage?: CbStage | null;
    cross_border_from?: UnderOrderMark | null;
    expected_to?: string | null;
  } | null;
  more: number;
}

export interface OrderListItem {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  total_uzs: number;
  items_count: number;
  payment_reported?: boolean;
  payment_method?: string | null;
  /** D-60: a paid order waiting for the USA shows its stage instead of «Оплачен» */
  cross_border_stage?: CbStage | null;
  cross_border_from?: UnderOrderMark | null;
}

export interface OrderPreview {
  items: (ShortNamed & { product_id: string; qty: number; unit_price_uzs: number; line_total_uzs: number; form?: string | null; image_url?: string | null; campaign?: { discount_pct: number } | null; cross_border?: boolean; under_order?: UnderOrderMark | null })[];
  /** D-60: lines from the USA — the promised window */
  cross_border?: CrossBorderWindow | null;
  skipped_unavailable: string[];
  totals: Totals;
  delivery: DeliveryQuote;
  /** 3.3: the applied code / why the requested code does not fit */
  promo?: PromoView | null;
  promo_rejection?: PromoRejection | null;
  /** 3.7 */
  campaigns?: CampaignLine[];
  problems: { code: string; product_id: string; requested: number; available: number }[];
  can_place: boolean;
  /** «Оплата при получении» is offered only for the city of Tashkent and up to the limit. */
  payment_options?: {
    cod: boolean;
    cod_unavailable: 'region' | 'limit' | 'off' | 'cross_border' | null;
    /** Payme: «Работает» and every product (and a paid delivery) has ИКПУ for the receipt */
    payme?: boolean;
    payme_unavailable?: 'off' | 'ikpu' | null;
  };
}

/** Payme: the payment page of the order (POST /payments/online/payme/orders/:id/start). */
export interface OnlinePaymentStart {
  payment_id: string;
  checkout_url: string;
  pay_until: string | null;
}

/** Payment instruction for a manual transfer (card or bank requisites). */
export interface BankTransfer {
  method: PaymentMethodCode;
  order_number: string;
  status: OrderStatus;
  payment_status: Order['payment_status'];
  amount_uzs: number;
  purpose: string;
  requisites: { recipient: string; bank_name: string; account: string; mfo: string; inn: string } | null;
  /** D-04: only the number; the card holder's name is never shown. */
  card: { card_number: string } | null;
  hint: LocalizedText;
  pay_until: string | null;
  customer_reported_paid_at: string | null;
  delivery_eta?: DeliveryEta | null;
  /** 3.1: link to the shop bot for this order's receipt (card transfer), and the last receipt sent */
  receipt?: { bot_url: string | null; last: { status: 'pending' | 'confirmed' | 'rejected'; reject_reason: string | null; created_at: string } | null };
}

export interface CheckoutDefaults {
  recipient_name: string;
  recipient_phone: string;
  region_id: string;
  city_id: string;
  address_text: string;
}

/** Home banner (Настройки → Главная → Баннеры): doctor / delivery are drawn by the Mini App, image is a picture from the admin panel. */
export interface ShopBanner {
  id: string;
  kind: 'doctor' | 'delivery' | 'ai' | 'image' | 'campaign';
  image_url: string | null;
  image_jpeg_url: string | null;
  link: { type: 'product' | 'category' | 'brand' | 'campaign'; value: string } | null;
  /** 3.7: a running sale — the slide is drawn by the Mini App with a countdown, first in the carousel */
  campaign?: CampaignSummary;
}

/** Home page: from which goods total delivery is free, and whether this customer's first order is delivered free. */
export interface FreeShipping {
  from_uzs: number | null;
  first_order_free: boolean;
}

/** The read-only cart counter: the badge in the top bar and the floating cart bar. */
export interface CartCount {
  items_count: number;
  goods_total_uzs: number;
}

/** 3.1: GET /cart/upsell — products close to the amount missing for free delivery. */
/** 3.4: «Проверить совместимость у специалиста» in the cart (GET /api/compat). */
export type CompatVerdict = 'compatible' | 'spread' | 'consult';
export interface CompatRequest {
  id: string;
  status: 'pending' | 'answered';
  source: 'specialist' | 'instant' | 'ai' | 'ai_cache' | 'ai_fallback';
  verdict: CompatVerdict | null;
  text: string | null;
  created_at: string;
  answered_at: string | null;
  /** the cart is not the one the answer was about any more */
  changed: boolean;
  products: string[];
}
export interface CompatState {
  eligible: boolean;
  products: string[];
  left_today: number;
  request: CompatRequest | null;
  result?: 'sent' | 'instant';
}

export interface CartUpsell {
  items: ProductListItem[];
  /** 3.5: next products, shown in place of a card added from the strip */
  spare?: ProductListItem[];
  source: 'auto' | 'manual' | null;
  remaining_uzs: number;
}

/** 3.8: VITALO AI in the cart (GET /api/compat/ai). */
export interface AiAnswer {
  answer_id: string;
  verdict: CompatVerdict;
  text: string;
  timing: { product_id: string; name: string; when: string }[];
  suggestions: { product_id: string; name: string }[];
  /** substances in 2+ products of the cart and the fixed line about them (D-47) */
  overlaps: string[];
  overlap_text: string | null;
  /** approved «осторожно с лекарствами» rules for the substances of the cart */
  drugs: string[];
  /** why the label is what it is: the badge words (3.8 fix) */
  reasons: { synergy: boolean; spread: boolean; avoid: boolean; overlap: boolean };
}
export interface AiState {
  /** false — no key or switched off: only the specialist */
  available: boolean;
  consent: boolean;
  eligible: boolean;
  left_today: number;
  /** an answer for this set is ready without a new check: no daily limit, the short animation */
  cached: boolean;
  /** the latest AI answer for the cart as it is now; Шаг 0а: shown only after the tap on «Проверить совместимость» */
  answer: AiAnswer | null;
  /** Шаг 0а: a specialist answer for this set — the link «Есть ответ специалиста VITALO»; conflict — another label than the AI */
  specialist?: { verdict: CompatVerdict; text: string; conflict: boolean } | null;
  result?: 'instant' | 'ai' | 'ai_cache' | 'specialist' | 'unavailable';
  reason?: string;
}

/** Шаг 0б: POST /api/compat/ai/goal — «Поможет ли этот набор для моей цели?» (D-69). */
export type AiGoalFit = 'helps' | 'maybe' | 'unlikely' | 'no_data';
export interface AiGoalAnswer {
  goal: 'sleep' | 'stress' | 'energy' | 'joints' | 'immunity' | 'sport';
  duration: string;
  kind: string;
  summary: string;
  /** level_text — the level of evidence in words from our base; null — no approved row («данных немного») */
  products: { product_id: string; name: string; fit: AiGoalFit; level: 'A' | 'B' | 'C' | null; level_text: string | null; text: string }[];
  steps: string[];
  /** «Если проблема держится дольше 3–4 недель — обратитесь к врачу.» */
  doctor: string;
  left_today: number;
}

/** D-70: «Спросить VITALO AI о корзине» — GET /api/compat/ai/chat, POST …/message. */
export type AiChatTopic = AiGoalAnswer['goal'] | 'compat' | 'other';
export interface AiChatProduct {
  product_id: string;
  name: string;
  /** null — a question of compatibility: no label */
  fit: AiGoalFit | null;
  level: 'A' | 'B' | 'C' | null;
  level_text: string | null;
  text: string;
  /** false — a product of the catalogue for an empty cart («В корзину») */
  in_cart: boolean;
}
export interface AiChatMessage {
  id: string;
  role: 'user' | 'ai';
  /** question | answer | clarify | off_topic | red_flag | failed */
  kind: string;
  text: string | null;
  created_at: string;
  topic?: AiChatTopic;
  products?: AiChatProduct[];
  steps?: string[];
  followups?: string[];
  options?: string[];
  doctor?: string | null;
  specialist?: boolean;
}
export interface AiChat {
  id: string;
  /** AI-20261112-0001 */
  number: string;
  questions: number;
  messages: AiChatMessage[];
}
export interface AiChatState {
  available: boolean;
  consent: boolean;
  left_today: number;
  max_chars: number;
  max_turns: number;
  topics: AiGoalAnswer['goal'][];
  chat: AiChat | null;
}

/** 6а-В (D-62): the manual promo label of a product, chosen in the admin product card. */
export type PromoLabel = 'eleven_eleven' | 'black_friday' | 'hit' | 'new';

/** 6а-Д: «Спросить специалиста» — the topic chips. */
export type SupportTopic = 'product' | 'medical' | 'order' | 'promo' | 'tech';
export interface SupportThread {
  id: string;
  /** 6б-Б: «0012» — shown as «Обращение №0012» */
  number: string;
  topic: SupportTopic;
  /** open — waits for the shop; answered — the shop replied last; closed */
  status: 'open' | 'answered' | 'closed';
  unread: number;
  /** customer | staff (the shop wrote first about an order) */
  started_by: 'customer' | 'staff';
  rating: number | null;
  closed_at: string | null;
  product: { id: string; name: string } | null;
  order: { id: string; number: string } | null;
  last_message_at: string;
  created_at: string;
  messages: { id: string; author: 'customer' | 'staff'; text: string; created_at: string }[];
}

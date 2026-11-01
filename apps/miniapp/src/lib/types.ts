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
export type OnlineMode = 'hidden' | 'soon' | 'live';

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
export type PaymentMethodCode = 'card_transfer' | 'bank_transfer' | 'cod';

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
  | { code: 'qty_reduced'; product_id: string; requested_qty: number; available_qty: number }
  | { code: 'out_of_stock'; product_id: string };

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
  unit_price_uzs: number;
  line_total_uzs: number;
}

export interface Cart {
  items: CartLine[];
  warnings: CartWarning[];
  goods_total_uzs: number;
  discount_total_uzs: number;
  items_count: number;
  can_checkout: boolean;
  delivery: DeliveryQuote | null;
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
  items: (ShortNamed & { product_id: string; sku: string; qty: number; unit_price_uzs: number; line_total_uzs: number; form?: string | null; image_url?: string | null })[];
  totals: Totals;
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
export type CentreTab = 'orders' | 'promo' | 'service';
export type CentreCounts = { unread: number; tabs: Record<CentreTab, number> };
/** One card per order (latest status, its steps, a note about the intake memo); other notices one card each. */
export interface CentreItem {
  id: string;
  tab: CentreTab;
  category: 'order' | 'waitlist' | 'promo';
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
}

export interface OrderPreview {
  items: (ShortNamed & { product_id: string; qty: number; unit_price_uzs: number; line_total_uzs: number; form?: string | null; image_url?: string | null })[];
  skipped_unavailable: string[];
  totals: Totals;
  delivery: DeliveryQuote;
  problems: { code: string; product_id: string; requested: number; available: number }[];
  can_place: boolean;
  /** «Оплата при получении» is offered only for the city of Tashkent and up to the limit. */
  payment_options?: { cod: boolean; cod_unavailable: 'region' | 'limit' | 'off' | null };
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
  kind: 'doctor' | 'delivery' | 'image';
  image_url: string | null;
  image_jpeg_url: string | null;
  link: { type: 'product' | 'category' | 'brand'; value: string } | null;
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
export interface CartUpsell {
  items: ProductListItem[];
  source: 'auto' | 'manual' | null;
  remaining_uzs: number;
}

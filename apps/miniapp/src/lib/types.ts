/** Shapes of API responses (apps/api). Money is integer UZS. */

export type Lang = 'ru' | 'uz';

export interface Named {
  name_ru: string;
  name_uz: string | null;
}

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

export type PaymentMethodCode = 'card_transfer' | 'bank_transfer';

export interface CategoryTrees {
  need: CategoryNode[];
  product_type: CategoryNode[];
}

export interface ProductListItem extends Named {
  id: string;
  sku: string;
  brand: string;
  price_uzs: number;
  old_price_uzs: number | null;
  image_url: string | null;
  in_stock: boolean;
}

export interface ProductCard extends ProductListItem {
  available_qty: number;
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
  media: { type: 'image' | 'document'; url: string; title: string | null; is_main: boolean }[];
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
export interface ShopInfo {
  product_disclaimer: LocalizedText;
  support_contact: string;
  support_url: string | null;
  payment_check_hours: { from: string; to: string };
  delivery_days_label: LocalizedText;
  delivery_terms: { tashkent: DaysRange | null; regions: DaysRange | null };
  home_content?: HomeContent;
  bonus_teaser?: { enabled: boolean; text: LocalizedText };
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
  items: { product_id: string; sku: string; name_ru: string; name_uz?: string | null; qty: number; unit_price_uzs: number; line_total_uzs: number }[];
  totals: Totals;
  payment: { method: string; status: string; amount_uzs: number; customer_reported_paid_at: string | null } | null;
  can_cancel: boolean;
  delivery_eta?: DeliveryEta | null;
  history: { from_status: string | null; to_status: OrderStatus; reason: string | null; created_at: string }[];
}

export interface OrderListItem {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  total_uzs: number;
  items_count: number;
  payment_reported?: boolean;
}

export interface OrderPreview {
  items: { product_id: string; name_ru: string; name_uz?: string | null; qty: number; unit_price_uzs: number; line_total_uzs: number }[];
  skipped_unavailable: string[];
  totals: Totals;
  delivery: DeliveryQuote;
  problems: { code: string; product_id: string; requested: number; available: number }[];
  can_place: boolean;
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
  card: { card_number: string; recipient: string } | null;
  hint: LocalizedText;
  pay_until: string | null;
  customer_reported_paid_at: string | null;
  delivery_eta?: DeliveryEta | null;
}

export interface CheckoutDefaults {
  recipient_name: string;
  recipient_phone: string;
  region_id: string;
  city_id: string;
  address_text: string;
}
